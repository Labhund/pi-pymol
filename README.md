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

Requirements: [pi](https://github.com/earendil-works/pi), PyMOL 2.6+ (3.1
verified) in your PATH.

```bash
pi install git:github.com/Labhund/pi-pymol@v0.1.0
```

Then in PyMOL, expose any session you want the agent to reach:

```
pi_pymol_start remote   # prints a /pymol connect ... line to paste into pi
```

### Plugin Manager install (GUI users)

Plugin Manager → **Install from URL** → paste:

```
https://raw.githubusercontent.com/Labhund/pi-pymol/main/dist/pi-pymol.zip
```

This installs a proper `pi-pymol` entry under the Plugin menu (with a
Start Listening dialog). Note: PyMOL may show an error box at the end of
the install — that is a cosmetic PyQt6 bug in PyMOL's own install
confirmation (`mimic_tk`), the plugin itself installs fine; restart PyMOL
and check Plugin → pi-pymol. Single-file installs (`__init__.py` or a
hashed URL temp name) cannot be named `pi-pymol` — the zip's internal
folder is what names the plugin.

And in your pi session:

```
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

Design phase. See [docs/design.md](docs/design.md) for the protocol, tool surface,
and phasing. Session 1 spike (headless render loop) in `scratch/`.

## Lineage

The PyMOL-side plugin is a credited fork of
[Arcadia-Science/agentic-pymol](https://github.com/Arcadia-Science/agentic-pymol)
(MIT), re-targeted from an MCP stdio server to a native pi extension speaking the
same socket protocol directly. The MCP layer is deliberately dropped: pi has no
MCP client, and an extension tool surface is strictly less machinery with the same
capabilities.

## License

MIT — see [LICENSE](LICENSE).
