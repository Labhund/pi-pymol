"""
Test fixtures.

The plugin imports `pymol` lazily inside handlers, so tests inject a fake
`pymol` module into `sys.modules` and exercise the plugin against it. The
plugin lives at `plugin/__init__.py` (a Plugin-Manager-friendly single file,
not an importable package name), so it is loaded from its path via importlib
under the module name `pi_pymol_plugin`.

Token auth is bypassed by setting `PI_PYMOL_TOKEN` to a fixed test value so
no real `~/.config/pi-pymol/token` is created.

Ported from Arcadia-Science/agentic-pymol (MIT); renames only: token path /
env var, module load mechanism, plus the `hello` handshake op which is a
pi-pymol addition. The interrupt-on-timeout tests that upstream ran against
its MCP client live in `extension/client.test.ts` here — our client is the
TypeScript one.
"""

from __future__ import annotations
import importlib.util
import json
import socket
import sys
import time
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from .fake_cmd import (
    FAKE_PYMOL_VERSION,
    LENGTH_HEADER,
    TEST_TOKEN,
    FakeCmd,  # noqa: F401 -- re-exported for the test modules
)


@pytest.fixture(autouse=True)
def _set_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PI_PYMOL_TOKEN", TEST_TOKEN)


@pytest.fixture
def fake_cmd() -> FakeCmd:
    return FakeCmd()


@pytest.fixture
def fake_pymol(fake_cmd: FakeCmd) -> Iterator[FakeCmd]:
    pymol_mod = types.ModuleType("pymol")
    pymol_mod.cmd = fake_cmd  # type: ignore[attr-defined]
    pymol_mod.__version__ = FAKE_PYMOL_VERSION  # type: ignore[attr-defined]
    sys.modules["pymol"] = pymol_mod
    yield fake_cmd
    sys.modules.pop("pymol", None)


def _load_plugin() -> Any:
    """Load plugin/__init__.py as an importable module.

    PyMOL's Plugin Manager copies the single file wherever it pleases and
    imports it under its own name; tests mirror that by loading from the path
    rather than relying on a package layout.
    """
    path = ROOT / "plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("pi_pymol_plugin", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pi_pymol_plugin"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin_module() -> Iterator[Any]:
    import logging

    plugin = _load_plugin()

    plugin._token = None
    plugin.socket_server = None
    plugin.listening = False
    plugin.current_port = plugin.DEFAULT_PORT
    plugin.dialog = None
    logging.getLogger("pymol-mcp-plugin").setLevel(logging.CRITICAL)
    yield plugin
    if plugin.socket_server is not None and plugin.listening:
        plugin.socket_server.stop()
        plugin.socket_server = None
        plugin.listening = False


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_for_port(host: str, port: int, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        probe = socket.socket()
        probe.settimeout(0.1)
        result = probe.connect_ex((host, port))
        probe.close()
        if result == 0:
            return
        time.sleep(0.02)
    raise RuntimeError(f"port {port} did not open within {timeout}s")


@pytest.fixture
def running_plugin(plugin_module: Any, fake_pymol: FakeCmd) -> Iterator[tuple[str, int]]:
    host = "127.0.0.1"
    port = _free_port()
    server = plugin_module.SocketServer(host=host, port=port)
    server.start()
    _wait_for_port(host, port)
    yield host, port
    server.stop()


def send_recv_raw(
    host: str, port: int, request: dict[str, Any], timeout: float = 5.0
) -> dict[str, Any]:
    """Bypass the TypeScript client for tests that manipulate the request envelope directly."""
    body = json.dumps(request).encode("utf-8")
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    sock.sendall(LENGTH_HEADER.pack(len(body)) + body)
    header = _recv_exactly(sock, LENGTH_HEADER.size)
    (length,) = LENGTH_HEADER.unpack(header)
    payload = _recv_exactly(sock, length)
    sock.close()
    return json.loads(payload.decode("utf-8"))


def _recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed during recv")
        buf.extend(chunk)
    return bytes(buf)
