# pi-pymol — design

Session 1 draft, 2026-09-02. This document locks the shape decisions made in the
2026-W36 spike session; it is a design doc, not the lab record (week notebook
remains the durable pre-promotion store for lab decisions).

## Decisions taken (2026-09-02, scientist-approved)

1. **Name:** `pi-pymol`. A pi Agent extension.
2. **Location:** `/data2/loo_lab/pi-pymol` — loo_lab root, not inside
   protein-design.
3. **Publishing:** public repo under the scientist's GitHub, consumable as a pi
   package (`pi install git:github.com/<owner>/pi-pymol`).
4. **Architecture:** two thin halves — a PyMOL plugin (Python, forked from
   Arcadia's agentic-pymol plugin, MIT, credited) and a pi extension (TypeScript)
   registering a typed tool surface. **No MCP.** pi has no MCP client by design;
   Arcadia's MCP server exists only to bridge stdio↔socket, which the extension
   replaces directly.
5. **Rejected:** PyMolAI (a PyMOL fork with an insular agent inside — re-implements
   the harness worse), ChatMol (same insular shape). Arcadia's assessment of these
   matches ours after reading their sources.
6. **Core design constraint:** the visual collaboration loop. State-changing calls
   can return viewport snapshots so the agent sees the result of its actions and
   iterates without the scientist relaying screenshots.
7. **Scope discipline:** PyMOL-native surfaces only (visualization, selection
   logic, geometry, alignment, rendering, session readback). No docking, sequence
   services, or external biology APIs. The lab analysis suite stays in Python and
   consumes bridge outputs as files.

## Protocol (v1)

Inherited from Arcadia's plugin where sound; changed where experience says so.

- **Transport:** localhost TCP, length-prefixed (`>I`) JSON frames, 4 MiB cap.
- **Auth:** shared-secret token file (`~/.config/pi-pymol/token`), HMAC-verified
  ops; side-channel interrupt op. (Kept from Arcadia.)
- **Handshake:** day-one addition — first op on every connection is
  `hello → {protocol: N, pymol_version, plugin_version}`. The extension refuses
  mismatched protocol versions with an actionable message. This is the
  many-years-change part; Arcadia has no versioning and we will not repeat that.
- **Ops:** `call` (cmd.*), `iterate`, `exec` (Python in PyMOL), `interrupt`,
  `hello`, `png` (viewport snapshot → base64 inline, or path on disk).

## Tool surface (v1 — pi extension side)

Small, typed, grows by demonstrated need only:

| Tool | Purpose |
|---|---|
| `pymol_status` | objects, selections, frame, state — session health |
| `pymol_do` | run a PyMOL command; returns output |
| `pymol_run` | run Python in PyMOL, return value |
| `pymol_iterate` | per-atom/residue property extraction (bounded) |
| `pymol_fasta` | sequences of a selection |
| `pymol_view` | get/set camera view |
| `pymol_geometry` | distances, angles, extents, RMSD/align |
| `pymol_screenshot` | viewport PNG inline to the model |
| `pymol_render` | ray-traced PNG to disk (artifact) |

Image flow: `pymol_screenshot` returns an image content block inline if the pi
tool-result path carries images (verify in S2); guaranteed fallback is PNG to
scratch + `read` (pi's `read` attaches images natively). Spike evidence so far:
`sendUserMessage` accepts image blocks (docs); tool-result image support TBC.

## Modes of use

- **Live session** (this desktop, `pymol` GUI running): interactive collaboration,
  agent drives the window the scientist is looking at.
- **Headless batch** (`pymol -cq script.py`, anywhere including over SSH):
  render figures, bulk analysis of Setonix-derived PDB/CIF files. No plugin
  needed — plain scripts + `read` on the PNGs. Documented in the skill, used for
  anything HPC-side.

## Phasing

- **S1 (this session):** scaffold, design doc, headless render-loop smoke test.
- **S2:** plugin fork + extension skeleton; `status`/`do`/`screenshot` against a
  live PyMOL; verify inline tool-result images.
- **S3:** full surface, tests ported/adapted from Arcadia, protocol handshake,
  skill drafts, promotion batch, GitHub publish.

## Threading model of headless PyMOL (verified 2026-09-02, pymol 3.1.0)

Learned the hard way during the S2 protocol tests; recorded because it
shapes how the plugin may be used headless:

- The PyMOL executive holds its global lock for the duration of a command;
  worker-thread `cmd.*` calls (the plugin's dispatch model) are serviced
  only when the executive idles.
- A `time.sleep` loop in the run script does not idle the executive: the
  first wedge (e.g. a fetch) blocks all subsequent ops.
- `cmd.do("_")` pumps and `-R`'s xmlrpc loop both deadlock worse (lock
  ping-pong with the worker).
- `cmd.fetch` from a worker thread deadlocks headless even on an idle
  executive (needs the GUI event loop); pre-fetch on the main thread during
  script setup, or fetch in a GUI session.
- The working headless configuration is `pymol -cpR -d "run ..."` with
  stdin held open (`tail -f /dev/null |`): `-p` spawns a stdin-reader
  thread, which keeps `_launch_no_gui`'s keep-alive loop running, and its
  `p.draw()` idles the executive so plugin ops complete (get_names 0.00s).
- `scripts/launch_headless.sh` encodes this; `run_server.py` pre-loads a
  structure on the main thread for tests.
