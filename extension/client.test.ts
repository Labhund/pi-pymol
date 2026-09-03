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