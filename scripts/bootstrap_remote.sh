#!/bin/sh
# One-time bootstrap for a Mac (or Linux) laptop: install the pi-pymol
# plugin so every PyMOL session can expose itself with `pi_pymol_start
# remote`. Run from a terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/Labhund/pi-pymol/v0.1.2/scripts/bootstrap_remote.sh | sh
#
set -eu
VERSION="${PI_PYMOL_VERSION:-v0.1.2}"
DIR="$HOME/.pymol.d"
mkdir -p "$DIR"
curl -fsSL "https://raw.githubusercontent.com/Labhund/pi-pymol/$VERSION/plugin/__init__.py" -o "$DIR/pi-pymol-plugin.py"

RC="$HOME/.pymolrc"
if [ -f "$RC" ]; then
  echo "pi-pymol: $RC already exists — leaving it alone."
  echo "pi-pymol: make sure it contains:  run $DIR/pi-pymol-autostart.py"
else
  cat > "$RC" <<EOF
run $DIR/pi-pymol-autostart.py
EOF
  cat > "$DIR/pi-pymol-autostart.py" <<EOF
import os
if not os.environ.get("PYMOL_HEADLESS"):
    plugin_path = os.path.expanduser("~/.pymol.d/pi-pymol-plugin.py")
    ns = {"__file__": plugin_path}
    exec(compile(open(plugin_path).read(), plugin_path, "exec"), ns)
    print("pi-pymol: loaded — run \`pi_pymol_start remote\` to get a paste line", flush=True)
EOF
  echo "pi-pymol: installed. Every PyMOL session now has the bridge commands."
fi
echo "pi-pymol: in PyMOL, run:  pi_pymol_start remote"
echo "pi-pymol: then paste the printed /pymol connect ... line into your pi session."
