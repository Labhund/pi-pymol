#!/bin/bash
# Rebuild dist/pi-pymol.zip for Plugin Manager installs (name comes from the
# internal folder: pi-pymol/__init__.py -> plugin named "pi-pymol").
set -eu
cd "$(dirname "$0")/../dist"
rm -rf pi-pymol pi-pymol.zip
mkdir pi-pymol
cp ../plugin/__init__.py pi-pymol/
curl -fsSL https://raw.githubusercontent.com/Arcadia-Science/agentic-pymol/v1.0.0/pymol_plugin/plugin.ui -o pi-pymol/plugin.ui
zip -r pi-pymol.zip pi-pymol/ >/dev/null
echo "built dist/pi-pymol.zip"
