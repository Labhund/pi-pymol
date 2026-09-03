# pi-pymol

A [pi](https://github.com/earendil-works/pi) Agent extension that lets a coding-agent
session drive a live PyMOL instance — run commands, query structures, and get viewport
images back inline so the agent can see what it is doing and iterate visually with the
scientist at the keyboard.

PyMOL stays a tool of your existing agent session. There is no embedded chatbot, no
forked PyMOL, no MCP intermediary.

```
┌──────────────┐  typed tools   ┌───────────────┐  length-prefixed  ┌──────────────┐
│  pi session  │───────────────▶│ pi extension  │───────JSON──────▶ │ PyMOL plugin │
│  (agent)     │◀────────────── │ (TypeScript)  │◀───────────────── │  (Python)    │
└──────────────┘   images back  └───────────────┘   token auth      └──────────────┘
                                                                        │
                                                                  live PyMOL window
```

## Install

Two pieces: the **pi extension** (the agent side) and the **PyMOL plugin**
(the PyMOL side). Both are needed. Requirements: [pi](https://github.com/earendil-works/pi),
PyMOL 2.6+ (3.1 verified) in your PATH.

**1. pi extension** — in a terminal:

```bash
pi install git:github.com/Labhund/pi-pymol@v0.1.3
```

**2. PyMOL plugin** — from PyMOL's Plugin Manager (**Plugin → Plugin Manager →
Install New Plugin**), either:

- **Install from URL** → paste:
  ```
  https://raw.githubusercontent.com/Labhund/pi-pymol/main/dist/pi-pymol.zip
  ```
  This installs a proper `pi-pymol` entry under the Plugin menu (with a
  Start Listening dialog). Note: PyMOL may show an error box at the end of
  the install — that is a cosmetic PyQt6 bug in PyMOL's own install
  confirmation (`mimic_tk`), the plugin itself installs fine; restart PyMOL
  and check Plugin → pi-pymol.
- or **Choose file** → select this repo's `plugin/__init__.py`. Single-file
  installs work but cannot be named `pi-pymol` (the Plugin Manager's name
  regex can't contain a hyphen), so they land under a generic menu name —
  the zip route is the better one.

Then pair the two sides:

```text
# in PyMOL's console:
pi_pymol_start remote   # prints a /pymol connect ... line to paste into pi

# in the pi session:
/pymol          # list live bridges and pair (per-session; nothing auto-attaches)
```

Tools: `pymol_status`, `pymol_do`, `pymol_run`, `pymol_iterate`,
`pymol_fasta`, `pymol_view`, `pymol_geometry`, `pymol_screenshot`,
`pymol_render`.

### Remote pairing (PyMOL on a laptop, pi over SSH/Tailscale)

> **Requires [Tailscale](https://tailscale.com/) on both machines.** That is
> the only supported remote transport — the bridge is a plain TCP socket
> gated by a shared token, and Tailscale provides the private path. If you
> need something else (SSH tunnel, plain LAN, public relay), please open an
> issue or PR rather than expecting support.

```python
# in PyMOL on the laptop (bind the tailnet IP — never 0.0.0.0 on shared
# networks: the exec op is arbitrary code execution, token-gated)
pi_pymol_start port=0, host=100.x.y.z
# → prints:  export PI_PYMOL_TOKEN=...
```

```bash
# in the remote pi session
export PI_PYMOL_TOKEN=...   # from the line above
/pymol 100.x.y.z:42813      # or just /pymol host:port and paste at the prompt
```

## Status

Working — local and Tailscale-remote pairing verified end-to-end (v0.1.3).
See [docs/design.md](docs/design.md) for the protocol, tool surface, and
phasing.

## Development

The Python plugin is tested against a fake `pymol` module (no PyMOL needed);
the TypeScript client runs against a real plugin server backed by that fake
(`tests/fake_pymol_server.py`):

```bash
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest tests -q
node --test extension/client.test.ts
```

## Lineage

The PyMOL-side plugin is a credited fork of
[Arcadia-Science/agentic-pymol](https://github.com/Arcadia-Science/agentic-pymol)
(MIT), re-targeted from an MCP stdio server to a native pi extension speaking the
same socket protocol directly. The MCP layer is deliberately dropped: pi has no
MCP client, and an extension tool surface is strictly less machinery with the same
capabilities.

## License

MIT — see [LICENSE](LICENSE).
