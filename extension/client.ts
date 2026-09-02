/**
 * pi-pymol socket client.
 *
 * Speaks the pi-pymol wire protocol (v1, forked from Arcadia's
 * agentic-pymol): localhost TCP, length-prefixed (uint32 BE) JSON frames,
 * shared-secret token on every request.
 *
 * Ops: hello | call | iterate | exec | interrupt
 * Response envelope: { ok, value?, stdout, error?: { type, message, traceback } }
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const TOKEN_PATH = path.join(os.homedir(), ".config", "pi-pymol", "token");

export const PROTOCOL_VERSION = 1;

export class PyMolError extends Error {
	type: string;
	traceback: string;
	stdout: string;

	constructor(type: string, message: string, traceback = "", stdout = "") {
		super(message);
		this.name = "PyMolError";
		this.type = type;
		this.traceback = traceback;
		this.stdout = stdout;
	}
}

interface Envelope {
	ok: boolean;
	value?: unknown;
	stdout?: string;
	error?: { type: string; message: string; traceback: string };
}

export interface HelloInfo {
	protocol: number;
	plugin_version: string;
	pymol_version: string;
}

function loadToken(envToken: string | undefined): string {
	if (envToken && envToken.trim()) return envToken.trim();
	if (fs.existsSync(TOKEN_PATH)) {
		const t = fs.readFileSync(TOKEN_PATH, "utf8").trim();
		if (t) return t;
	}
	throw new PyMolError(
		"NoToken",
		`no pi-pymol token found (env PI_PYMOL_TOKEN or ${TOKEN_PATH}); ` +
			"start PyMOL's pi-pymol plugin (Plugin → pi-pymol → Start Listening) to generate one",
	);
}

export class PyMolClient {
	private host: string;
	private port: number | null;
	private timeoutMs: number;
	private sock: net.Socket | null = null;
	private token: string | null = null;
	private helloInfo: HelloInfo | null = null;

	constructor(opts: { host?: string; port?: number; timeoutMs?: number } = {}) {
		this.host = opts.host ?? "127.0.0.1";
		// Explicit port (arg or PI_PYMOL_PORT env) pairs immediately; otherwise
		// the client is unpaired until /pymol selects a PyMOL session.
		const envPort = parsePortEnv();
		this.port = opts.port ?? envPort ?? null;
		this.timeoutMs = opts.timeoutMs ?? parseTimeoutEnv() ?? DEFAULT_TIMEOUT_MS;
	}

	get paired(): boolean {
		return this.port !== null;
	}

	/** Pair with a specific PyMOL bridge; resets connection + handshake cache. */
	setPort(port: number): void {
		this.close();
		this.helloInfo = null;
		this.token = null;
		this.port = port;
	}

	/** Forget the current pairing (connection failure, explicit /pymol off). */
	unpair(): void {
		this.close();
		this.helloInfo = null;
		this.token = null;
		this.port = null;
	}

	private getToken(): string {
		if (this.token === null) this.token = loadToken(process.env.PI_PYMOL_TOKEN);
		return this.token;
	}

	private connect(): Promise<net.Socket> {
		if (this.sock) return Promise.resolve(this.sock);
		if (this.port === null) {
			return Promise.reject(
				new PyMolError(
					"NotPaired",
					"no PyMOL session paired with this pi session — run /pymol to pick one " +
						"(and pi_pymol_start in the PyMOL console if none is listed)",
				),
			);
		}
		return new Promise((resolve, reject) => {
			const sock = net.createConnection({ host: this.host, port: this.port });
			const fail = (err: Error) => {
				sock.destroy();
				reject(
					new PyMolError(
						"ConnectionError",
						`could not connect to pi-pymol plugin at ${this.host}:${this.port} (${err.message}). ` +
							"Is PyMOL running with the pi-pymol plugin listening?",
					),
				);
			};
			sock.once("error", fail);
			sock.once("connect", () => {
				sock.removeListener("error", fail);
				this.sock = sock;
				resolve(sock);
			});
		});
	}

	private close(): void {
		if (this.sock) {
			this.sock.destroy();
			this.sock = null;
		}
	}

	/** Best-effort interrupt on a side channel (matches Arcadia's client). */
	private bestEffortInterrupt(): void {
		if (this.token === null) return;
		try {
			if (this.port === null) return;
			const frame = encodeFrame(JSON.stringify({ op: "interrupt", token: this.token }));
			const side = net.createConnection({ host: this.host, port: this.port });
			side.on("connect", () => {
				side.write(frame);
				side.end();
			});
			side.on("error", () => {});
		} catch {
			// best effort only
		}
	}

	private sendRecv(request: Record<string, unknown>, timeoutMs: number): Promise<Envelope> {
		return this.connect().then(
			(sock) =>
				new Promise<Envelope>((resolve, reject) => {
					const body = encodeFrame(JSON.stringify({ ...request, token: this.getToken() }));
					if (body.length > MAX_MESSAGE_BYTES) {
						reject(new PyMolError("RequestTooLarge", `request of ${body.length} bytes exceeds cap`));
						return;
					}

					let buffer = Buffer.alloc(0);
					let expected: number | null = null;
					let settled = false;

					const finish = (err: PyMolError | null, env?: Envelope) => {
						if (settled) return;
						settled = true;
						sock.removeListener("data", onData);
						sock.setTimeout(0);
						if (err) reject(err);
						else resolve(env!);
					};

					const onData = (chunk: Buffer) => {
						buffer = Buffer.concat([buffer, chunk]);
						if (expected === null) {
							if (buffer.length < 4) return;
							expected = buffer.readUInt32BE(0);
							buffer = buffer.subarray(4);
							if (expected > MAX_MESSAGE_BYTES) {
								this.close();
								finish(new PyMolError("ResponseTooLarge", `response of ${expected} bytes exceeds cap`));
								return;
							}
						}
						if (buffer.length < expected) return;
						try {
							const env = JSON.parse(buffer.subarray(0, expected).toString("utf8")) as Envelope;
							finish(null, env);
						} catch (e) {
							finish(new PyMolError("ProtocolError", `bad JSON from plugin: ${String(e)}`));
						}
					};

					sock.on("data", onData);
					sock.setTimeout(timeoutMs, () => {
						this.close();
						this.bestEffortInterrupt();
						finish(
							new PyMolError(
								"TransportTimeout",
								`call exceeded ${timeoutMs}ms; interrupt sent to PyMOL — long C-layer ops ` +
									"(e.g. ray) will bail out, pure-Python loops may not",
							),
						);
					});
					sock.once("error", (err: Error) => {
						this.close();
						finish(new PyMolError("TransportError", `socket I/O failed: ${err.message}`));
					});
					sock.write(body);
				}),
		);
	}

	private async do(request: Record<string, unknown>, timeoutMs?: number): Promise<Envelope> {
		const t0 = Date.now();
		const env = await this.sendRecv(request, timeoutMs ?? this.timeoutMs);
		if (!env.ok) {
			const err = env.error ?? { type: "Unknown", message: "no error detail", traceback: "" };
			throw new PyMolError(err.type, err.message, err.traceback, env.stdout ?? "");
		}
		return env;
	}

	/** Handshake: check protocol compatibility; runs once, then cached. */
	async hello(): Promise<HelloInfo> {
		if (this.helloInfo) return this.helloInfo;
		const env = await this.do({ op: "hello" });
		const info = env.value as HelloInfo;
		if (info.protocol !== PROTOCOL_VERSION) {
			this.helloInfo = null;
			throw new PyMolError(
				"ProtocolMismatch",
				`plugin speaks protocol ${info.protocol}, extension expects ${PROTOCOL_VERSION} — ` +
					"update whichever side is older",
			);
		}
		this.helloInfo = info;
		return info;
	}

	call(fn: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}, timeoutMs?: number) {
		return this.do({ op: "call", fn, args, kwargs }, timeoutMs);
	}

	iterate(selection: string, properties: string[], state: number, timeoutMs?: number) {
		return this.do({ op: "iterate", selection, properties, state }, timeoutMs);
	}

	execCode(code: string, returnExpr?: string, timeoutMs?: number) {
		return this.do({ op: "exec", code, return_expr: returnExpr ?? null }, timeoutMs);
	}
}

export function text(s: string) {
	return { type: "text" as const, text: s };
}

export function pngBlock(base64: string) {
	// pi internal image block shape (see custom-provider-anthropic example)
	return { type: "image" as const, mimeType: "image/png", data: base64 };
}

function encodeFrame(json: string): Buffer {
	const body = Buffer.from(json, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length, 0);
	return Buffer.concat([header, body]);
}

function parsePortEnv(): number | undefined {
	const v = Number(process.env.PI_PYMOL_PORT);
	return Number.isInteger(v) && v > 0 ? v : undefined;
}

function parseTimeoutEnv(): number | undefined {
	const v = Number(process.env.PI_PYMOL_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}
