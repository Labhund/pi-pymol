/**
 * pi-pymol — a pi Agent extension driving a live PyMOL session.
 *
 * Forked tool-surface design from Arcadia-Science/agentic-pymol (MIT);
 * re-targeted from MCP stdio to a native pi extension speaking the plugin's
 * socket protocol directly. See docs/design.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PyMolClient, PyMolError, pngBlock, text } from "./client.ts";

const client = new PyMolClient();

interface BridgeSession {
	pid: number;
	port: number;
	started: string;
}

/** Live pi-pymol bridges, from the plugin's session registry (~/.config/pi-pymol/sessions). */
function listSessions(): BridgeSession[] {
	const dir = path.join(os.homedir(), ".config", "pi-pymol", "sessions");
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const live: BridgeSession[] = [];
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		try {
			const sess = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as BridgeSession;
			if (typeof sess.pid !== "number" || typeof sess.port !== "number") throw new Error("bad file");
			process.kill(sess.pid, 0); // throws ESRCH if dead
			live.push(sess);
		} catch (e) {
			// stale registry entry (PyMOL closed) — clean it up
			if ((e as NodeJS.ErrnoException).code === "ESRCH" || (e as NodeJS.ErrnoException).code === "ENOENT") {
				fs.rmSync(path.join(dir, name), { force: true });
			}
		}
	}
	return live.sort((a, b) => a.port - b.port);
}

function errContent(e: unknown) {
	const msg = e instanceof PyMolError ? `${e.type}: ${e.message}` : String(e);
	return { content: [text(`pymol error — ${msg}`)], isError: true, details: {} };
}

function withHello<T>(fn: (args: Static<T>) => Promise<{ content: unknown[]; details?: object }>) {
	// pi calls execute(toolCallId, params, ...); we only care about params.
	return async (_toolCallId: string, args: Static<T>) => {
		try {
			await client.hello();
			return await fn(args);
		} catch (e) {
			return errContent(e);
		}
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pymol", {
		description:
			"Pair this session with a live PyMOL bridge (/pymol to pick, /pymol <port>, or /pymol <host>:<port> for remote e.g. Tailscale)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const remote = arg.match(/^([\w.-]+):(\d+)$/); // host:port
			if (remote) {
				const host = remote[1];
				const port = Number(remote[2]);
				let token = process.env.PI_PYMOL_TOKEN?.trim();
				if (!token) {
					token = await ctx.ui.input(
						"Bridge token",
						`paste the PI_PYMOL_TOKEN printed by pi_pymol_start on ${host}`,
					);
				}
				if (!token) return;
				await pair(port, ctx, host, token);
				return;
			}
			const direct = arg && Number(arg);
			if (direct) {
				await pair(Number(arg), ctx);
				return;
			}
			const sessions = listSessions();
			if (sessions.length === 0) {
				ctx.ui.notify(
					"no live pi-pymol bridges — run  pi_pymol_start  in a PyMOL console first",
					"warning",
				);
				return;
			}
			if (sessions.length === 1) {
				await pair(sessions[0].port, ctx);
				return;
			}
			const options = sessions.map(
				(s) => `port ${s.port} — pid ${s.pid}, started ${s.started}`,
			);
			const pick = await ctx.ui.select("Pair with PyMOL session:", options);
			if (pick === undefined) return;
			const chosen = sessions[options.indexOf(pick)];
			if (chosen) await pair(chosen.port, ctx);
		},
	});

	async function pair(
		port: number,
		ctx: { ui: { notify(msg: string, kind?: string): void; input(title: string, hint?: string): Promise<string | undefined> } },
		host?: string,
		token?: string,
	) {
		if (host) client.setTarget(host, port, token);
		else client.setPort(port);
		try {
			const hello = await client.hello();
			ctx.ui.notify(
				`paired: PyMOL ${hello.pymol_version} on ${host ?? "127.0.0.1"}:${port} (protocol ${hello.protocol})`,
				"info",
			);
		} catch (e) {
			client.unpair();
			const msg = e instanceof PyMolError ? `${e.type}: ${e.message}` : String(e);
			ctx.ui.notify(`pairing failed on ${host ?? "127.0.0.1"}:${port} — ${msg}`, "error");
		}
	}

	pi.registerTool({
		name: "pymol_status",
		label: "PyMOL status",
		description:
			"Session health of the live PyMOL: protocol handshake, object and selection names, frame, state. Call first to verify the bridge.",
		parameters: Type.Object({}),
		execute: withHello(async () => {
			const hello = await client.hello();
			const status = await client.call("get_names", [], {});
			return {
				content: [
					text(
						`PyMOL ${hello.pymol_version} · plugin ${hello.plugin_version} · protocol ${hello.protocol}\n` +
							JSON.stringify(status.value, null, 2),
					),
				],
				details: { hello, names: status.value },
			};
		}),
	});

	pi.registerTool({
		name: "pymol_do",
		label: "PyMOL command",
		description:
			"Run a PyMOL command in the live session (e.g. 'fetch 1ubq', 'show cartoon', 'color magenta, resi 72-76'). Returns the command output.",
		parameters: Type.Object({
			command: Type.String({ description: "PyMOL command line" }),
			timeout_ms: Type.Optional(Type.Number({ description: "timeout in ms (default 60000)" })),
		}),
		execute: withHello(async (args) => {
			const r = await client.call("do", [args.command], {}, args.timeout_ms);
			return { content: [text(String(r.stdout ?? ""))], details: { value: r.value } };
		}),
	});

	pi.registerTool({
		name: "pymol_run",
		label: "PyMOL Python",
		description:
			"Run arbitrary Python inside the PyMOL interpreter (cmd.* API available). Optionally eval a return expression. Use when a single command isn't enough.",
		parameters: Type.Object({
			code: Type.String({ description: "Python code to exec" }),
			return_expr: Type.Optional(Type.String({ description: "expression to eval and return" })),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		execute: withHello(async (args) => {
			const r = await client.execCode(args.code, args.return_expr, args.timeout_ms);
			return {
				content: [text([r.stdout ?? "", r.value === undefined ? "" : String(r.value)].join("\n"))],
				details: { value: r.value },
			};
		}),
	});

	pi.registerTool({
		name: "pymol_iterate",
		label: "PyMOL iterate",
		description:
			"Extract per-atom/residue properties from a selection (e.g. ['name','resn','resi','ss','b']). Bounded at 200k rows.",
		parameters: Type.Object({
			selection: Type.String({ description: "PyMOL selection expression" }),
			properties: Type.Array(Type.String(), {
				description: "atom properties: name, resn, resi, chain, ss, b, q, elem, coord, ...",
			}),
			state: Type.Optional(Type.Number({ description: "state index (default: current)" })),
		}),
		execute: withHello(async (args) => {
			const r = await client.iterate(args.selection, args.properties, args.state ?? -1);
			const rows = r.value as Record<string, unknown>[];
			return { content: [text(JSON.stringify(rows, null, 1))], details: { n: rows.length } };
		}),
	});

	pi.registerTool({
		name: "pymol_fasta",
		label: "PyMOL FASTA",
		description: "Get the FASTA sequence of a selection.",
		parameters: Type.Object({
			selection: Type.String({ description: "PyMOL selection (default 'all')" }),
		}),
		execute: withHello(async (args) => {
			const r = await client.call("get_fastastr", [args.selection ?? "all"]);
			return { content: [text(String(r.value))], details: {} };
		}),
	});

	pi.registerTool({
		name: "pymol_screenshot",
		label: "PyMOL screenshot",
		description:
			"Capture the current PyMOL viewport as an image returned inline, so you can SEE the current view. Use after any display change to verify visually. ray=true does a slow ray-traced render instead of the instant viewport snapshot.",
		parameters: Type.Object({
			width: Type.Optional(Type.Number({ description: "default 800" })),
			height: Type.Optional(Type.Number({ description: "default 600" })),
			ray: Type.Optional(Type.Boolean({ description: "ray-trace (slow, high quality)" })),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		execute: withHello(async (args) => {
			const tmp = path.join(
				fs.mkdtempSync(path.join(os.tmpdir(), "pi-pymol-")),
				"viewport.png",
			);
			const r = await client.call(
				"png",
				[tmp],
				{
					width: args.width ?? 800,
					height: args.height ?? 600,
					ray: args.ray ? 1 : 0,
					dpi: -1,
				},
				args.timeout_ms ?? (args.ray ? 300_000 : undefined),
			);
			const data = fs.readFileSync(tmp);
			fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
			return {
				content: [
					text(`Viewport captured (${data.length} bytes). ${String(r.stdout ?? "")}`),
					pngBlock(data.toString("base64")),
				],
				details: { bytes: data.length },
			};
		}),
	});

	pi.registerTool({
		name: "pymol_view",
		label: "PyMOL view",
		description:
			"Get or set the camera view of the live PyMOL session. Call with no arguments to read the current 18-float view matrix (save this before camera changes so you can restore the scientist's framing); pass `view` to restore/set one, optionally animating.",
		parameters: Type.Object({
			view: Type.Optional(
				Type.Array(Type.Number(), { description: "18 floats as returned by this tool with no arguments" }),
			),
			animate: Type.Optional(Type.Number({ description: "seconds of interpolation (default 0)" })),
		}),
		execute: withHello(async (args) => {
			if (args.view) {
				if (args.view.length !== 18) {
					return { content: [text("view must be exactly 18 floats")], isError: true, details: {} };
				}
				await client.call("set_view", [args.view], { animate: args.animate ?? 0 });
				return { content: [text("view applied")], details: {} };
			}
			const r = await client.call("get_view", [], {});
			return { content: [text(JSON.stringify(r.value))], details: { view: r.value } };
		}),
	});

	pi.registerTool({
		name: "pymol_geometry",
		label: "PyMOL geometry",
		description:
			"Measure geometry or align structures in the live session. ops: distance/angle/dihedral (n single-atom selections, order matters); align (full alignment of mobile onto target: refined+initial RMSD, atom counts); rms (raw RMSD between selections). Selections are PyMOL selection expressions.",
		parameters: Type.Object({
			op: Type.String({ description: "distance | angle | dihedral | align | rms" }),
			selections: Type.Array(Type.String(), {
				description: "2 for distance/rms, 3 for angle, 4 for dihedral; align uses [mobile, target]",
			}),
		}),
		execute: withHello(async (args) => {
			const [a, b, c, d] = args.selections;
			switch (args.op) {
				case "distance": {
					const r = await client.call("get_distance", [a, b], {});
					return { content: [text(`distance ${a} <-> ${b}: ${r.value} A`)], details: { value: r.value } };
				}
				case "angle": {
					const r = await client.call("get_angle", [a, b, c], {});
					return { content: [text(`angle ${a}, ${b}, ${c}: ${r.value} deg`)], details: { value: r.value } };
				}
				case "dihedral": {
					const r = await client.call("get_dihedral", [a, b, c, d], {});
					return { content: [text(`dihedral: ${r.value} deg`)], details: { value: r.value } };
				}
				case "align": {
					const r = await client.call("align", [a, b], {});
					const v = r.value as number[];
					const [rmsdRef, nRef, nCycles, rmsdInit, nInit, rawScore, nRes] = v;
					return {
						content: [
							text(
								`align ${a} -> ${b}: refined RMSD ${rmsdRef} A over ${nRef} atoms ` +
									`(${nCycles} cycles); initial RMSD ${rmsdInit} A over ${nInit} atoms; ` +
									`${nRes} residues aligned`,
							),
						],
						details: { rmsd_refined: rmsdRef, n_atoms_refined: nRef, rmsd_initial: rmsdInit, n_residues: nRes },
					};
				}
				case "rms": {
					const r = await client.call("rms_cur", [a, b], {});
					return { content: [text(`rms ${a} vs ${b}: ${r.value} A`)], details: { value: r.value } };
				}
				default:
					return {
						content: [text(`unknown op '${args.op}' — use distance|angle|dihedral|align|rms`)],
						isError: true,
						details: {},
					};
			}
		}),
	});

	pi.registerTool({
		name: "pymol_render",
		label: "PyMOL render",
		description:
			"Ray-trace the current view to a PNG file on disk (publication-style artifact). Returns the absolute path. For seeing the view inline use pymol_screenshot.",
		parameters: Type.Object({
			filename: Type.String({ description: "output PNG path" }),
			width: Type.Optional(Type.Number({ description: "default 1024" })),
			height: Type.Optional(Type.Number({ description: "default 768" })),
			dpi: Type.Optional(Type.Number({ description: "-1 keeps current" })),
			ray: Type.Optional(Type.Boolean({ description: "default true" })),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		execute: withHello(async (args) => {
			const resolved = path.resolve(args.filename.replace(/^~/, os.homedir()));
			await client.call(
				"png",
				[resolved],
				{
					width: args.width ?? 1024,
					height: args.height ?? 768,
					dpi: args.dpi ?? -1,
					ray: (args.ray ?? true) ? 1 : 0,
				},
				args.timeout_ms ?? 300_000,
			);
			return { content: [text(resolved)], details: { path: resolved } };
		}),
	});
}
