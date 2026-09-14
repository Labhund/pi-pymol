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

/**
 * PyMOL console lines emitted during the op (same text the GUI console shows).
 * Without these, interpreter errors are invisible to the agent — it sees only
 * empty stdout and cannot react. Included as a separate block; empty when the
 * plugin (<=0.1.3) or the op emitted nothing.
 */
function consoleText(env: { console?: unknown }): string {
	const lines = Array.isArray(env.console) ? env.console.map(String) : [];
	if (lines.length === 0) return "";
	const shown = lines.slice(-30);
	const more = lines.length > shown.length ? `\n…[+${lines.length - shown.length} earlier console lines elided]` : "";
	return `pymol console:\n${shown.join("\n")}${more}`;
}

/**
 * Empty results must never look like silence: a bare "" or "null" reads as
 * "nothing happened" and the agent guesses (2026-09-14: six consecutive
 * empty results before a freeze — the model kept iterating blind). State
 * completion explicitly, and point at return_expr for pymol_run.
 */
function outputOrNoOutput(stdout: string | undefined, isRun: boolean): string {
	const out = (stdout ?? "").trim();
	if (out) return out;
	return isRun
		? "(completed — no output; if you expected data, pass return_expr)"
		: "(completed — no output)";
}

/** Attach console output to a tool result, if any was emitted. */
function withConsole(
	content: unknown[],
	env: { console?: unknown; stdout?: unknown },
	details: Record<string, unknown>,
): { content: unknown[]; details: Record<string, unknown> } {
	const c = consoleText(env);
	if (c) {
		content.push(text(c));
		details.console = env.console;
	}
	return { content, details };
}

function withHello<T>(fn: (args: Static<T>, signal: AbortSignal | undefined) => Promise<{ content: unknown[]; details?: object }>) {
	// pi calls execute(toolCallId, params, signal, onUpdate, ctx); we forward
	// the abort signal so Esc/turn-cancel can break a pending socket call —
	// a hung PyMOL op must never be un-interruptible (2026-09-14 freeze).
	return async (_toolCallId: string, args: Static<T>, signal?: AbortSignal) => {
		try {
			await client.hello(signal);
			return await fn(args, signal);
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
			const connect = arg.match(/^connect\s+([\w.-]+):(\d+):(.+)$/); // the one-paste line
			if (connect) {
				await pair(Number(connect[2]), ctx, connect[1], connect[3].trim());
				return;
			}
			const remote = arg.match(/^([\w.-]+):(\d+)$/); // host:port (token via env or prompt)
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
		execute: withHello(async (_args, signal) => {
			const hello = await client.hello();
			const status = await client.call("get_names", [], {}, undefined, signal);
			const { content, details } = withConsole(
				[
					text(
						`PyMOL ${hello.pymol_version} · plugin ${hello.plugin_version} · protocol ${hello.protocol}\n` +
							JSON.stringify(status.value, null, 2),
					),
				],
				status,
				{ hello, names: status.value },
			);
			return { content, details };
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
		execute: withHello(async (args, signal) => {
			const r = await client.call("do", [args.command], {}, args.timeout_ms, signal);
			return withConsole([text(outputOrNoOutput(r.stdout, false))], r, { value: r.value });
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
		execute: withHello(async (args, signal) => {
			const r = await client.execCode(args.code, args.return_expr, args.timeout_ms, signal);
			const body = [r.stdout ?? "", r.value === undefined ? "" : String(r.value)]
				.join("\n")
				.trim();
			return withConsole(
				[text(body || outputOrNoOutput(r.stdout, true))],
				r,
				{ value: r.value },
			);
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
		execute: withHello(async (args, signal) => {
			const r = await client.iterate(args.selection, args.properties, args.state ?? -1, undefined, signal);
			const rows = r.value as Record<string, unknown>[];
			return withConsole([text(JSON.stringify(rows, null, 1))], r, { n: rows.length });
		}),
	});

	pi.registerTool({
		name: "pymol_fasta",
		label: "PyMOL FASTA",
		description: "Get the FASTA sequence of a selection.",
		parameters: Type.Object({
			selection: Type.String({ description: "PyMOL selection (default 'all')" }),
		}),
		execute: withHello(async (args, signal) => {
			const r = await client.call("get_fastastr", [args.selection ?? "all"], {}, undefined, signal);
			return withConsole([text(String(r.value))], r, {});
		}),
	});

	pi.registerTool({
		name: "pymol_screenshot",
		label: "PyMOL screenshot",
		description:
			"Capture the current PyMOL viewport as an image returned inline, so you can SEE the current view. Use after any display change to verify visually. ray=true does a slow ray-traced render instead of the instant viewport snapshot.",
		parameters: Type.Object({
			width: Type.Optional(
				Type.Number({
					description:
						"force a pixel width — RESIZES the live viewport on Wayland (2026-09-14); omit to capture at native window size",
				}),
			),
			height: Type.Optional(
				Type.Number({ description: "force a pixel height — see width warning" }),
			),
			ray: Type.Optional(Type.Boolean({ description: "ray-trace (slow, high quality)" })),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		execute: withHello(async (args, signal) => {
			// Render to a temp file on the PYMOL machine, then ship the bytes
			// back as base64 — agent and PyMOL may be on different machines
			// (remote pairing), so a shared filesystem must not be assumed.
			const tmp = path.join(os.tmpdir(), `pi-pymol-${process.pid}-${Date.now()}.png`);
			// cmd.png with an explicit size RESIZES the live GL viewport in the
			// ray=0 readback path and never restores it (Wayland: the Qt dock
			// grows each shot; measured 2026-09-14). ray=1 renders offscreen at
			// the requested size without touching the window — so a forced size
			// always goes through ray. Models habitually pass explicit sizes
			// from context, so this guard is what keeps their layout intact.
			const wantSize = args.width != null || args.height != null;
			const useRay = args.ray ?? wantSize;
			const sizeSafe = !wantSize || useRay;
			const w = sizeSafe ? (args.width ?? 0) : 0;
			const h = sizeSafe ? (args.height ?? 0) : 0;
			const code = [
				"import base64, os",
				`cmd.png(${JSON.stringify(tmp)}, width=${w}, height=${h}, ray=${useRay ? 1 : 0}, dpi=-1)`,
				`_b = base64.b64encode(open(${JSON.stringify(tmp)}, 'rb').read()).decode()`,
				`os.remove(${JSON.stringify(tmp)})`,
			].join("\n");
			const r = await client.execCode(code, "_b", args.timeout_ms ?? (useRay ? 300_000 : undefined), signal);
			const data = Buffer.from(String(r.value), "base64");
			const note =
				wantSize && !sizeSafe
					? "forced size ignored: explicit size with ray=false resizes the live viewport (Wayland); captured native instead. "
					: "";
			const { content, details } = withConsole(
				[
					text(
						`${note}Viewport captured (${data.length} bytes${useRay && wantSize ? `, ray ${args.width ?? "?"}x${args.height ?? "?"}` : ""}). ${String(r.stdout ?? "")}`,
					),
					pngBlock(String(r.value)),
				],
				r,
				{ bytes: data.length },
			);
			return { content, details };
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
		execute: withHello(async (args, signal) => {
			if (args.view) {
				if (args.view.length !== 18) {
					return { content: [text("view must be exactly 18 floats")], isError: true, details: {} };
				}
				const r = await client.call("set_view", [args.view], { animate: args.animate ?? 0 }, undefined, signal);
				return withConsole([text("view applied")], r, {});
			}
			const r = await client.call("get_view", [], {}, undefined, signal);
			return withConsole([text(JSON.stringify(r.value))], r, { view: r.value });
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
		execute: withHello(async (args, signal) => {
			const [a, b, c, d] = args.selections;
			switch (args.op) {
				case "distance": {
					const r = await client.call("get_distance", [a, b], {}, undefined, signal);
					return withConsole(
						[text(`distance ${a} <-> ${b}: ${r.value} A`)],
						r,
						{ value: r.value },
					);
				}
				case "angle": {
					const r = await client.call("get_angle", [a, b, c], {}, undefined, signal);
					return withConsole(
						[text(`angle ${a}, ${b}, ${c}: ${r.value} deg`)],
						r,
						{ value: r.value },
					);
				}
				case "dihedral": {
					const r = await client.call("get_dihedral", [a, b, c, d], {}, undefined, signal);
					return withConsole([text(`dihedral: ${r.value} deg`)], r, { value: r.value });
				}
				case "align": {
					const r = await client.call("align", [a, b], {}, undefined, signal);
					const v = r.value as number[];
					const [rmsdRef, nRef, nCycles, rmsdInit, nInit, rawScore, nRes] = v;
					return withConsole(
						[
							text(
								`align ${a} -> ${b}: refined RMSD ${rmsdRef} A over ${nRef} atoms ` +
									`(${nCycles} cycles); initial RMSD ${rmsdInit} A over ${nInit} atoms; ` +
									`${nRes} residues aligned`,
							),
						],
						r,
						{ rmsd_refined: rmsdRef, n_atoms_refined: nRef, rmsd_initial: rmsdInit, n_residues: nRes },
					);
				}
				case "rms": {
					const r = await client.call("rms_cur", [a, b], {}, undefined, signal);
					return withConsole([text(`rms ${a} vs ${b}: ${r.value} A`)], r, { value: r.value });
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
			"Ray-trace the current view to a PNG file on disk (publication-style artifact). The file is written on the machine PyMOL runs on — with remote pairing that is the remote machine. Returns the absolute path. For seeing the view inline use pymol_screenshot.",
		parameters: Type.Object({
			filename: Type.String({ description: "output PNG path" }),
			width: Type.Optional(Type.Number({ description: "default 1024" })),
			height: Type.Optional(Type.Number({ description: "default 768" })),
			dpi: Type.Optional(Type.Number({ description: "-1 keeps current" })),
			ray: Type.Optional(Type.Boolean({ description: "default true" })),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		execute: withHello(async (args, signal) => {
			const resolved = path.resolve(args.filename.replace(/^~/, os.homedir()));
			const r = await client.call(
				"png",
				[resolved],
				{
					// 0 = render at current viewport size. An explicit size would
					// churn the live viewport (growing-panel bug on Wayland).
					width: args.width ?? 0,
					height: args.height ?? 0,
					dpi: args.dpi ?? -1,
					ray: (args.ray ?? true) ? 1 : 0,
				},
				args.timeout_ms ?? 300_000,
				signal,
			);
			return withConsole([text(resolved)], r, { path: resolved });
		}),
	});
}
