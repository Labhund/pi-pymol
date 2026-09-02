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
