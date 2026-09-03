"""
Standalone plugin-server harness for the TypeScript client integration tests
(extension/client.test.ts).

Installs the shared FakeCmd as a fake `pymol` module, loads the real plugin
from plugin/__init__.py, and serves the real socket protocol on 127.0.0.1.
Prints lifecycle lines on stdout for the test runner to read:

    READY <port>        once the server is accepting connections
    INTERRUPTS <n>      whenever cmd.interrupt() has been called (count)

Needs no third-party packages; run with any system python3.
"""

from __future__ import annotations
import argparse
import importlib.util
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tests.fake_cmd import FAKE_PYMOL_VERSION, FakeCmd  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--lifetime", type=float, default=30.0,
        help="exit after this many seconds so a crashed test runner can never orphan us",
    )
    args = parser.parse_args()

    fake_cmd = FakeCmd()
    pymol_mod = types.ModuleType("pymol")
    pymol_mod.cmd = fake_cmd  # type: ignore[attr-defined]
    pymol_mod.__version__ = FAKE_PYMOL_VERSION  # type: ignore[attr-defined]
    sys.modules["pymol"] = pymol_mod

    spec = importlib.util.spec_from_file_location("pi_pymol_plugin", ROOT / "plugin" / "__init__.py")
    assert spec is not None and spec.loader is not None
    plugin = importlib.util.module_from_spec(spec)
    sys.modules["pi_pymol_plugin"] = plugin
    spec.loader.exec_module(plugin)

    server = plugin.SocketServer(host="127.0.0.1", port=args.port)
    if not server.start():
        raise RuntimeError("failed to start plugin server")
    print(f"READY {server.socket.getsockname()[1]}", flush=True)

    reported = 0
    deadline = time.monotonic() + args.lifetime
    try:
        while time.monotonic() < deadline:
            time.sleep(0.05)
            if fake_cmd.interrupt_calls != reported:
                reported = fake_cmd.interrupt_calls
                # stderr: a worker thread's redirect_stdout (process-global!) would
                # swallow a stdout print while a slow call is in flight.
                print(f"INTERRUPTS {reported}", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()
