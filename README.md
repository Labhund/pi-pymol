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
