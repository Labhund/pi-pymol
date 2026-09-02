#!/bin/bash
# Launch headless PyMOL with the pi-pymol plugin listening.
# Usage: scripts/launch_headless.sh [port]
#
# Why this shape (pymol 3.1, verified 2026-09-02): with -c, PyMOL's
# _launch_no_gui loop runs while a stdin-reader thread exists (-p) and each
# pass calls p.draw(), which idles the executive — exactly what services
# worker-thread cmd calls from the plugin. `tail -f /dev/null` holds stdin
# open with no data. A sleep loop inside the run script does NOT work: the
# executive holds its global lock for the whole command, so plugin ops queue
# until the mainloop idles, and busy-loops/cmd.do pumps deadlock instead.
PORT="${1:-9877}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PI_PYMOL_REPO="$REPO" PI_PYMOL_TEST_PORT=$PORT exec bash -c 'exec tail -f /dev/null | exec pymol -cpR -d "run '"$REPO"'/scripts/run_server.py"'
