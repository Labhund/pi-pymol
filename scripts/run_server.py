"""Headless test runner: load the pi-pymol plugin and start listening.

Run: PI_PYMOL_TEST_PORT=9878 pymol -cq /abs/path/scripts/run_server.py

Threading notes (learned the hard way, see docs/design.md):
- Worker-thread cmd.* calls (the plugin's dispatch model) complete fine in
  headless PyMOL as long as the main thread does NOT touch the PyMOL API
  after the script's setup: no cmd.do pump, no -R xmlrpc loop. Both of those
  ping-pong the global lock and deadlock simple calls.
- cmd.fetch() from a worker thread deadlocks headless (it needs the main
  thread's event loop). Pre-fetch structures on the main thread here, or use
  a GUI session for fetch.
"""
import logging
import os
import sys
import time

logging.basicConfig(level=logging.INFO)

REPO = os.environ.get("PI_PYMOL_REPO") or os.path.dirname(os.path.abspath(__file__))
plugin_path = os.path.join(REPO, "plugin", "__init__.py")
plugin_ns = {"__file__": plugin_path}
exec(compile(open(plugin_path).read(), plugin_path, "exec"), plugin_ns)

from pymol import cmd  # noqa: E402

# main-thread setup while the API is un contended
if not cmd.get_names("public"):
    cmd.fetch("1ubq", async_=0)
    cmd.hide("everything")
    cmd.show("cartoon")
    cmd.spectrum("count")
    cmd.bg_color("white")
    cmd.orient()

plugin_ns["pi_pymol_start"](int(os.environ.get("PI_PYMOL_TEST_PORT", "9877")))

# Script ENDS here. Under `pymol -cqR` PyMOL then enters its executive
# mainloop, which is what services worker-thread cmd calls. Never busy-loop
# or sleep in this script — the executive holds the global lock for the whole
# command, so plugin ops queue until the mainloop idles.
