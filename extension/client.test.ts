/**
 * Integration tests for the TypeScript socket client (extension/client.ts)
 * against the real plugin server running on FakeCmd (tests/fake_pymol_server.py).
 *
 * Ports the parts of Arcadia-Science/agentic-pymol's test_interrupt.py that
 * upstream ran against its Python MCP client — our client is the pi
 * extension's TypeScript one, so the client-side timeout→side-channel-interrupt
 * contract is tested here, against the actual implementation:
 *
 *   - a call that exceeds the client timeout surfaces TransportTimeout AND
 *     fires op="interrupt" on a fresh connection (the plugin reports the
 *     count via INTERRUPTS lines on the harness stdout);
 *   - a plain transport error surfaces TransportError and must NOT fire
 *     interrupt (observed as zero interrupt frames reaching the peer).
 *
 * Run: node --test extension/client.test.ts
 */

import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PyMolClient, PyMolError } from "./client.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-1234567890abcdef";

process.env.PI_PYMOL_TOKEN = TOKEN;

/** LineReader over a child process stdout, with a deadline-guarded wait. */
class Lines {
	private buf = "";
	private queue: string[] = [];
	private wake: (() => void) | null = null;

	constructor(stream: NodeJS.ReadableStream) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			this.buf += chunk;
			let idx: number;
			while ((idx = this.buf.indexOf("\n")) !== -1) {
				const line = this.buf.slice(0, idx).trim();
				this.buf = this.buf.slice(idx + 1);
				if (line) this.push(line);
			}
		});
	}

	private push(line: string) {
		this.queue.push(line);
		this.wake?.();
		this.wake = null;
	}

	async waitFor(predicate: (line: string) => boolean, what: string, deadlineMs = 5000) {
		const deadline = Date.now() + deadlineMs;
		for (;;) {
			const hit = this.queue.find(predicate);
			if (hit !== undefined) return hit;
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${what}; saw [${this.queue.join(" | ")}]`);
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
				setTimeout(resolve, 50);
			});
		}
	}
}

let server: ChildProcess | null = null;
let port = 0;
let out: Lines;
let errLines: Lines;

async function startPluginServer(): Promise<void> {
	server = spawn(process.env.PI_PYMOL_TEST_PYTHON ?? "python3", ["tests/fake_pymol_server.py"], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	out = new Lines(server.stdout!);
	errLines = new Lines(server.stderr!);
	const ready = await out.waitFor((l) => l.startsWith("READY "), "READY line");
	port = Number(ready.split(" ")[1]);
}

function newClient(timeoutMs?: number): PyMolClient {
	const client = new PyMolClient({ host: "127.0.0.1", port, timeoutMs });
	return client;
}

before(async () => {
	await startPluginServer();
});

after(() => {
	server?.kill("SIGKILL");
});

test("hello handshake reports protocol and versions", { timeout: 10_000 }, async () => {
	const info = await newClient().hello();
	assert.equal(info.protocol, 1);
	assert.equal(typeof info.plugin_version, "string");
	assert.ok(info.plugin_version.length > 0);
	assert.equal(info.pymol_version, "3.1.0");
});

test("call round-trips through the framed protocol", { timeout: 10_000 }, async () => {
	const client = newClient();
	const env = await client.call("echo", ["hello"]);
	assert.equal(env.ok, true);
	assert.equal(env.value, "hello");
});

test(
	"timeout surfaces TransportTimeout and fires the side-channel interrupt",
	{ timeout: 15_000 },
	async () => {
		const client = newClient(150);
		await assert.rejects(
			client.call("slow", [], { duration: 1.0 }),
			(err: unknown) => err instanceof PyMolError && err.type === "TransportTimeout",
		);
		// the plugin must have received op="interrupt" on a fresh connection
		const line = await errLines.waitFor((l) => l === "INTERRUPTS 1", "INTERRUPTS 1");
		assert.equal(line, "INTERRUPTS 1");
	},
);

test("second call reconnects after the plugin closed the previous connection", { timeout: 10_000 }, async () => {
	// Regression for the 2026-09-14 freeze: the client cached a socket the
	// peer had closed; write() on the destroyed socket silently did nothing
	// (no error/close events), so every later call pended forever. The client
	// must detect the corpse and reconnect.
	let reqs = 0;
	const oneShot = net.createServer((sock) => {
		let answered = false;
		sock.on("data", (chunk: Buffer) => {
			// ignore interrupt side-channel frames
			if (chunk.toString("utf8").includes('"op":"interrupt"')) return;
			if (answered) return; // one answer per connection, even if the
			answered = true;      // request arrives split across chunks
			reqs++;
			const body = Buffer.from(JSON.stringify({ ok: true, value: `r${reqs}`, stdout: "" }));
			const head = Buffer.alloc(4);
			head.writeUInt32BE(body.length, 0);
			sock.write(Buffer.concat([head, body]));
			sock.end(); // graceful peer close right after answering
		});
	});
	await new Promise<void>((resolve) => oneShot.listen(0, "127.0.0.1", resolve));
	const p = (oneShot.address() as net.AddressInfo).port;
	try {
		const client = new PyMolClient({ host: "127.0.0.1", port: p, timeoutMs: 3000 });
		const first = await client.call("echo", ["a"]);
		assert.equal(first.value, "r1");
		// must NOT hang on the destroyed cached socket
		const second = await client.call("echo", ["b"]);
		assert.equal(second.value, "r2");
		assert.equal(reqs, 2, "second request must arrive over a fresh connection");
	} finally {
		oneShot.close();
	}
});

test("watchdog is wall-clock: fires even while the peer keeps the connection noisy", { timeout: 10_000 }, async () => {
	// A socket-inactivity timeout dies with the socket; the watchdog must not.
	// The peer never answers but keeps writing noise, so any inactivity-based
	// timer would keep resetting — the call must still time out on schedule.
	const srv = net.createServer((sock) => {
		sock.on("data", () => {}); // swallow requests, never respond
		// stream a valid header announcing a 1 MiB response, then drip bytes
		// forever without ever completing it: every drip resets socket
		// inactivity, so an inactivity-based timeout would never fire
		const head = Buffer.alloc(4);
		head.writeUInt32BE(1048576, 0);
		sock.write(head);
		const drip = setInterval(() => {
			try { sock.write("\x00"); } catch { /* ignore */ }
		}, 50);
		sock.on("close", () => clearInterval(drip));
		sock.on("error", () => {});
	});
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const p = (srv.address() as net.AddressInfo).port;
	try {
		const client = new PyMolClient({ host: "127.0.0.1", port: p, timeoutMs: 250 });
		const t0 = Date.now();
		await assert.rejects(
			client.call("echo", ["x"]),
			(err: unknown) => err instanceof PyMolError && err.type === "TransportTimeout",
		);
		assert.ok(Date.now() - t0 < 2000, "watchdog must fire on wall-clock schedule");
	} finally {
		srv.close();
	}
});

test("abort signal breaks a pending call and fires the side-channel interrupt", { timeout: 15_000 }, async () => {
	const client = newClient(30_000);
	const ac = new AbortController();
	const pending = client.call("slow", [], { duration: 2.0 }, undefined, ac.signal);
	setTimeout(() => ac.abort(), 150);
	await assert.rejects(
		pending,
		(err: unknown) => err instanceof PyMolError && err.type === "Aborted",
	);
	// the plugin must have received op="interrupt" on a fresh connection
	// (cumulative counter: the earlier timeout test fired INTERRUPTS 1)
	const line = await errLines.waitFor((l) => l === "INTERRUPTS 2", "INTERRUPTS 2");
	assert.equal(line, "INTERRUPTS 2");
});

test("parallel calls are serialized (LLM agents fire tools concurrently)", { timeout: 15_000 }, async () => {
	// Two 200ms ops in parallel must take >= 400ms wall-clock: the client op
	// queue must make parallel tool calls behave as serial ones (plus the
	// inter-op gap). Under ~350ms means they ran concurrently.
	const client = newClient(30_000);
	const t0 = Date.now();
	const results = await Promise.all([
		client.call("slow", [], { duration: 0.2 }),
		client.call("slow", [], { duration: 0.2 }),
	]);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed >= 350, `parallel slow ops finished in ${elapsed}ms — expected >=400ms (serialized)`);
	assert.equal(results[0].ok, true);
	assert.equal(results[1].ok, true);
});

test("queue survives a rejected call (no deadlock on failure)", { timeout: 15_000 }, async () => {
	const client = newClient(30_000);
	// op that fails must not wedge the chain for the next op
	await assert.rejects(
		client.execCode("raise ValueError('boom')", "None"),
		(err: unknown) => err instanceof PyMolError && err.type === "ValueError",
	);
	const after = await client.call("echo", ["alive"]);
	assert.equal(after.value, "alive");
});

test("plain transport error surfaces TransportError and fires no interrupt", { timeout: 15_000 }, async () => {
	// A peer that accepts and immediately destroys each connection: the client
	// must see a transport error (not a timeout), and any side-channel interrupt
	// attempt would arrive as a new connection carrying an interrupt frame.
	let interruptFrames = 0;
	const hostile = net.createServer((sock) => {
		sock.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes('"op":"interrupt"')) interruptFrames++;
		});
		sock.destroy();
	});
	await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
	const hostilePort = (hostile.address() as net.AddressInfo).port;

	try {
		const client = new PyMolClient({ host: "127.0.0.1", port: hostilePort, timeoutMs: 5000 });
		await assert.rejects(
			client.call("echo", ["hi"]),
			(err: unknown) => err instanceof PyMolError && err.type === "TransportError",
		);

		// give any (wrong) side-channel interrupt time to arrive
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(interruptFrames, 0, "no interrupt frame may be sent on a plain transport error");
	} finally {
		hostile.close();
	}
});