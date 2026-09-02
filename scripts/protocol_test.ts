/**
 * Protocol test: drives the headless PyMOL plugin through the extension's
 * client. Run: node scripts/protocol_test.ts
 */

import { PyMolClient, PyMolError } from "../extension/client.ts";
import assert from "node:assert";

const client = new PyMolClient({ timeoutMs: 240_000 });

// 1. handshake
const hello = await client.hello();
console.log("hello:", hello);
assert.strictEqual(hello.protocol, 1);
assert.ok(hello.pymol_version);

// 2. call: structure pre-loaded by run_server.py (worker-thread fetch
// deadlocks headless — see run_server.py notes)
const names = await client.call("get_names", [], {});
console.log("objects:", names.value);
assert.ok((names.value as string[]).includes("1ubq"));

// 3. do: display state
const out = await client.execCode(
  "cmd.hide('everything'); cmd.show('cartoon'); cmd.spectrum('count'); cmd.orient(); cmd.bg_color('white')",
);
console.log("do stdout:", JSON.stringify(out.stdout));

// 4. exec with return: geometry
const dist = await client.execCode(
  "import pymol\n_assert = cmd.get_model('resi 1 and name N').atom[0], cmd.get_model('resi 72 and name N').atom[0]",
  "round(float(__import__('math').dist(_x[0].coord, _x[1].coord)), 2) if (_x := None) is None else None",
).catch((e) => null);
// simpler: distance via cmd
const d = await client.execCode(
  "import math\np1 = cmd.get_model('resi 1 and name N').atom[0].coord\np2 = cmd.get_model('resi 72 and name N').atom[0].coord",
  "round(math.dist(p1, p2), 2)",
);
console.log("N1-N72 distance:", d.value);

// 5. iterate
const rows = await client.iterate("ss h", ["resi", "name"], -1);
console.log("helix atoms:", (rows.value as unknown[]).length);

// 6. fasta
const fasta = await client.call("get_fastastr", ["1ubq"]);
console.log("fasta head:", String(fasta.value).split("\n")[0]);

// 7. screenshot (ray — headless has no viewport)
await client.call("png", ["/tmp/pi-pymol-test.png"], { width: 640, height: 480, ray: 1, dpi: -1 }, 240_000);
const fs = await import("node:fs");
const bytes = fs.statSync("/tmp/pi-pymol-test.png").size;
console.log("screenshot bytes:", bytes);
assert.ok(bytes > 10_000, "png should be non-trivial");

// 8. error surface: bad selection
try {
  await client.call("select", ["nonexistent_object_xyz"]);
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof PyMolError);
  console.log("error surfaced as:", e.type, "-", e.message.slice(0, 60));
}

console.log("\nALL PROTOCOL TESTS PASSED");
process.exit(0);
