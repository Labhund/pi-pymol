# pyright: reportMissingImports=false
"""
pi-pymol PyMOL plugin: TCP server that accepts framed JSON requests from
the pi-pymol agent extension, gates them on a shared-secret token, and
dispatches to PyMOL's `cmd.*` API.

Forked from Arcadia-Science/agentic-pymol v1.0.0 (MIT), Copyright (c)
2026 Arcadia Science. Modifications for pi-pymol: token path moved to
~/.config/pi-pymol/token (env override PI_PYMOL_TOKEN), protocol-version
`hello` handshake op added, menu rebranded. Upstream has no protocol
versioning; see docs/design.md for the pi-pymol protocol v1 notes.

Concession to PyMOL's Plugin Manager: this module is intentionally one big
file. The Plugin Manager's "Install New Plugin → Choose file…" flow copies
exactly the file you select; it does not follow `from .submodule import ...`
to pull siblings along. So a package layout (auth.py / framing.py /
handlers.py / serialize.py / server.py) breaks naive installation with
`No module named 'pymol_plugin'` because only `__init__.py` ends up on disk.
Collapsing everything to a single file lets users do the documented
"select `__init__.py`" step and have it actually work.

The conceptual layout is preserved by section header comments:

    SERIALIZE — JSON-friendly conversion of PyMOL return values
    FRAMING   — length-prefixed wire protocol
    AUTH      — shared-secret token load / create / verify
    HANDLERS  — op dispatch (call / iterate / exec / interrupt)
    SERVER    — accept loop + per-connection worker
    PLUGIN    — PyMOL Plugin Manager hooks (menu, dialog, start/stop)

The MCP-side client (`agentic_pymol/`) is unaffected and keeps its
multi-module layout — it has no Plugin Manager constraint.
"""

from __future__ import annotations
import hmac
import io
import json
import logging
import math
import os
import re
import secrets
import socket
import struct
import threading
import time
import traceback
from contextlib import redirect_stdout, suppress
from pathlib import Path
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# Module-level constants and globals
# ─────────────────────────────────────────────────────────────────────────────

MAX_MESSAGE_BYTES = 4 * 1024 * 1024
LENGTH_HEADER = struct.Struct(">I")

TOKEN_PATH = Path.home() / ".config" / "pi-pymol" / "token"
PROTOCOL_VERSION = 1
PLUGIN_VERSION = "0.1.0"
TOKEN_BYTES = 32

ITERATE_ROW_LIMIT = 200_000
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")

DEFAULT_PORT = 9877

logger = logging.getLogger("pymol-mcp-plugin")
_token: str | None = None


# ─────────────────────────────────────────────────────────────────────────────
# SERIALIZE
# ─────────────────────────────────────────────────────────────────────────────


def serialize(value: Any) -> Any:
    """
    Convert a PyMOL return value into a JSON-friendly shape.

    Non-finite floats (NaN, +/-inf) are coerced to `None` so the resulting
    payload is strict JSON: Python's `json.dumps` would otherwise emit the
    non-standard `NaN` / `Infinity` tokens, which most strict parsers reject.
    The coercion applies recursively to floats inside lists, dicts, ndarray
    data, and atom fields.
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [serialize(v) for v in value]
    if isinstance(value, dict):
        return {str(k): serialize(v) for k, v in value.items()}
    np = _maybe_numpy()
    if np is not None and isinstance(value, np.ndarray):
        return {
            "_kind": "ndarray",
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "data": serialize(value.tolist()),
        }
    indexed_cls = _maybe_chempy_indexed()
    if indexed_cls is not None and isinstance(value, indexed_cls):
        return {
            "_kind": "model",
            "atoms": [_serialize_atom(a) for a in value.atom],
            "n_atoms": len(value.atom),
        }
    return {"_kind": "repr", "value": repr(value)[:2000]}


def _serialize_atom(atom: Any) -> dict[str, Any]:
    fields = (
        "name",
        "resn",
        "resi",
        "chain",
        "segi",
        "elem",
        "ss",
        "b",
        "q",
        "vdw",
        "partial_charge",
        "formal_charge",
        "index",
        "id",
    )
    out: dict[str, Any] = {}
    for f in fields:
        if hasattr(atom, f):
            out[f] = serialize(getattr(atom, f))
    if hasattr(atom, "coord"):
        out["coord"] = serialize(list(atom.coord))
    return out


def _maybe_numpy():
    try:
        import numpy

        return numpy
    except ImportError:
        return None


def _maybe_chempy_indexed():
    try:
        from chempy import Indexed

        return Indexed
    except ImportError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# FRAMING
# ─────────────────────────────────────────────────────────────────────────────


def recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed during recv")
        buf.extend(chunk)
    return bytes(buf)


def recv_message(sock: socket.socket) -> dict[str, Any]:
    header = recv_exactly(sock, LENGTH_HEADER.size)
    (length,) = LENGTH_HEADER.unpack(header)
    if length > MAX_MESSAGE_BYTES:
        raise ValueError(f"message length {length} exceeds {MAX_MESSAGE_BYTES} byte cap")
    body = recv_exactly(sock, length)
    return json.loads(body.decode("utf-8"))


def send_message(sock: socket.socket, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        body = json.dumps(
            {
                "ok": False,
                "error": {
                    "type": "ResponseTooLarge",
                    "message": f"response of {len(body)} bytes exceeds {MAX_MESSAGE_BYTES} cap",
                    "traceback": "",
                },
                "stdout": "",
            }
        ).encode("utf-8")
    sock.sendall(LENGTH_HEADER.pack(len(body)) + body)


# ─────────────────────────────────────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────────────────────────────────────


def _load_or_create_token() -> str:
    env = os.environ.get("PI_PYMOL_TOKEN", "").strip()
    if env:
        return env
    if TOKEN_PATH.exists():
        existing = TOKEN_PATH.read_text().strip()
        if existing:
            return existing
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(TOKEN_BYTES)
    TOKEN_PATH.write_text(token)
    TOKEN_PATH.chmod(0o600)
    logger.info(f"pi-pymol: generated new shared-secret token at {TOKEN_PATH}")
    return token


def get_token() -> str:
    global _token
    if _token is None:
        _token = _load_or_create_token()
    return _token


def token_ok(presented: Any) -> bool:
    if not isinstance(presented, str):
        return False
    return hmac.compare_digest(presented, get_token())


# ─────────────────────────────────────────────────────────────────────────────
# HANDLERS
# ─────────────────────────────────────────────────────────────────────────────


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    if not token_ok(request.get("token")):
        return _error_response("Unauthorized", "missing or invalid auth token", "", "")
    op = request.get("op")
    if op == "hello":
        import pymol
        from pymol import cmd as _cmd
        version = getattr(pymol, "__version__", None) or _cmd.get_version()[0]
        return {
            "ok": True,
            "value": {
                "protocol": PROTOCOL_VERSION,
                "plugin_version": PLUGIN_VERSION,
                "pymol_version": version,
            },
            "stdout": "",
        }
    if op == "call":
        return _handle_call(request)
    if op == "iterate":
        return _handle_iterate(request)
    if op == "exec":
        return _handle_exec(request)
    if op == "interrupt":
        return _handle_interrupt(request)
    return _error_response("BadRequest", f"unknown op: {op!r}", "", "")


def _handle_interrupt(request: dict[str, Any]) -> dict[str, Any]:
    from pymol import cmd

    logger.info("pi-pymol interrupt requested")
    cmd.interrupt()
    return {"ok": True, "value": None, "stdout": ""}


def _handle_call(request: dict[str, Any]) -> dict[str, Any]:
    fn_name = request.get("fn", "")
    args = request.get("args", []) or []
    kwargs = request.get("kwargs", {}) or {}
    if not isinstance(fn_name, str) or not fn_name:
        return _error_response("BadRequest", "fn must be a non-empty string", "", "")
    from pymol import cmd

    target: Any = cmd
    for part in fn_name.split("."):
        if not IDENTIFIER_RE.match(part):
            return _error_response("BadRequest", f"invalid attribute name: {part!r}", "", "")
        if not hasattr(target, part):
            return _error_response("AttributeError", f"cmd has no attribute {fn_name!r}", "", "")
        target = getattr(target, part)
    if not callable(target):
        return _error_response("TypeError", f"{fn_name!r} is not callable", "", "")
    logger.info(f"pi-pymol call: {fn_name}(args={args!r}, kwargs={kwargs!r})")
    return _run_capturing(lambda: target(*args, **kwargs))


def _handle_iterate(request: dict[str, Any]) -> dict[str, Any]:
    selection = request.get("selection", "")
    properties = request.get("properties", []) or []
    state = request.get("state")
    if not isinstance(selection, str):
        return _error_response("BadRequest", "selection must be a string", "", "")
    if not isinstance(properties, list) or not all(isinstance(p, str) for p in properties):
        return _error_response("BadRequest", "properties must be a list of strings", "", "")
    for p in properties:
        if not IDENTIFIER_RE.match(p):
            return _error_response("BadRequest", f"invalid property identifier: {p!r}", "", "")
    if not properties:
        return _error_response("BadRequest", "properties must not be empty", "", "")
    if not isinstance(state, int) or isinstance(state, bool):
        return _error_response("BadRequest", "state must be an int", "", "")

    from pymol import cmd

    payload = "{" + ", ".join(f'"{p}": {p}' for p in properties) + "}"
    expression = (
        f"(_acc.append({payload}) if len(_acc) < {ITERATE_ROW_LIMIT} else _overflow.append(1))"
    )
    space: dict[str, Any] = {"_acc": [], "_overflow": []}

    def thunk():
        return cmd.iterate_state(state, selection, expression, space=space)

    logger.info(
        f"pi-pymol iterate: selection={selection!r}, properties={properties!r}, state={state!r}"
    )
    result = _run_capturing(thunk)
    if not result["ok"]:
        return result
    if space["_overflow"]:
        return _error_response(
            "IterateOverflow",
            f"iterate produced more than {ITERATE_ROW_LIMIT} rows; narrow the selection",
            "",
            result["stdout"],
        )
    return {
        "ok": True,
        "value": [serialize(row) for row in space["_acc"]],
        "stdout": result["stdout"],
    }


def _handle_exec(request: dict[str, Any]) -> dict[str, Any]:
    """
    Run arbitrary Python in the plugin's interpreter and (optionally) eval a
    return expression. Intentionally unsandboxed: callers can import anything,
    touch the filesystem, and make network calls. Gated only by the
    shared-secret token validated upstream in `dispatch`; the listening socket
    is bound to 127.0.0.1 so it is not reachable off-host without explicit
    forwarding.
    """
    code = request.get("code", "")
    return_expr = request.get("return_expr")
    if not isinstance(code, str):
        return _error_response("BadRequest", "code must be a string", "", "")
    if return_expr is not None and not isinstance(return_expr, str):
        return _error_response("BadRequest", "return_expr must be a string or null", "", "")
    import pymol
    from pymol import cmd

    exec_globals: dict[str, Any] = {
        "cmd": cmd,
        "pymol": pymol,
        "__builtins__": __builtins__,
    }
    np = _maybe_numpy()
    if np is not None:
        exec_globals["np"] = np
    logger.info(f"pi-pymol exec ({len(code)} chars, return_expr={return_expr!r})")

    def thunk():
        exec(code, exec_globals)
        if return_expr is None:
            return None
        return eval(return_expr, exec_globals)

    return _run_capturing(thunk)


def _run_capturing(thunk) -> dict[str, Any]:
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            value = thunk()
    except Exception as e:
        return _error_response(
            type(e).__name__,
            str(e),
            traceback.format_exc(),
            buffer.getvalue(),
        )
    return {
        "ok": True,
        "value": serialize(value),
        "stdout": buffer.getvalue(),
    }


def _error_response(error_type: str, message: str, tb: str, stdout: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {"type": error_type, "message": message, "traceback": tb},
        "stdout": stdout,
    }


# ─────────────────────────────────────────────────────────────────────────────
# SERVER
# ─────────────────────────────────────────────────────────────────────────────


class SocketServer:
    def __init__(self, host: str = "127.0.0.1", port: int = DEFAULT_PORT):
        self.host = host
        self.port = port
        self.socket: socket.socket | None = None
        self.running = False
        self.thread: threading.Thread | None = None

    def start(self) -> bool:
        if self.running:
            return False
        get_token()
        # Bind synchronously so callers can read getsockname() immediately
        # after start() returns (the accept loop still runs in the thread).
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind((self.host, self.port))
        self.socket.listen(4)
        self.socket.settimeout(0.1)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        return True

    def stop(self) -> None:
        self.running = False
        if self.thread:
            self.thread.join(2.0)
        if self.socket:
            try:
                self.socket.close()
            except OSError:
                pass
        self.socket = None
        self.thread = None

    def _run(self) -> None:
        try:
            logger.info(f"pi-pymol socket server listening on {self.host}:{self.port}")
            while self.running:
                try:
                    client, address = self.socket.accept()
                except TimeoutError:
                    continue
                except OSError as e:
                    logger.info(f"accept error: {e}")
                    break
                logger.info(f"pi-pymol client connected: {address}")
                threading.Thread(target=self._serve_client, args=(client,), daemon=True).start()
        except Exception as e:
            logger.info(f"PyMOL MCP socket server error: {e}")
            traceback.print_exc()
        finally:
            if self.socket:
                try:
                    self.socket.close()
                except OSError:
                    pass
            logger.info("PyMOL MCP socket server stopped")

    def _serve_client(self, client: socket.socket) -> None:
        client.settimeout(None)
        try:
            while self.running:
                request = recv_message(client)
                response = dispatch(request)
                send_message(client, response)
        except (ConnectionError, OSError) as e:
            logger.info(f"pi-pymol client disconnected: {e}")
        except Exception as e:
            logger.info(f"PyMOL MCP client handler crashed: {e}")
            traceback.print_exc()
        finally:
            try:
                client.close()
            except OSError:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# SESSION REGISTRY (filesystem pairing between PyMOL and pi sessions)
# ─────────────────────────────────────────────────────────────────────────────

SESSIONS_DIR = Path.home() / ".config" / "pi-pymol" / "sessions"


def _write_session_file(port: int, host: str = "127.0.0.1") -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "pid": os.getpid(),
        "port": int(port),
        "host": host,
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (SESSIONS_DIR / f"{port}.json").write_text(json.dumps(payload))


def _remove_session_file(port: int) -> None:
    with suppress(OSError):
        (SESSIONS_DIR / f"{port}.json").unlink()


# ─────────────────────────────────────────────────────────────────────────────
# CONSOLE COMMANDS (explicit pairing; pi_pymol_start binds a random free port)
# ─────────────────────────────────────────────────────────────────────────────

def pi_pymol_start(port: int = 0, host: str = "") -> None:
    """Start the bridge on `port` (0 = pick a random free port) and register
    the session file that `/pymol` in a pi session discovers.

    host: bind address; default 127.0.0.1 (PI_PYMOL_HOST env overrides).
    For remote pairing (e.g. over Tailscale) bind the tailnet IP, NEVER
    0.0.0.0 on shared networks — the exec op is arbitrary code execution
    gated only by the token. Non-loopback binds print an export line with
    the token to paste into the remote pi session."""
    global socket_server, listening, current_port
    if listening:
        print(f"pi-pymol: already listening on port {current_port}")
        return
    bind_host = str(host).strip() or os.environ.get("PI_PYMOL_HOST", "") or "127.0.0.1"
    try:
        server = SocketServer(host=bind_host, port=int(port))
        if not server.start():
            print("pi-pymol: failed to start (was it already started?)")
            return
    except OSError as e:
        print(f"pi-pymol: failed to start ({e})")
        return
    socket_server = server
    listening = True
    current_port = server.socket.getsockname()[1]
    _write_session_file(current_port, bind_host)
    print(f"pi-pymol: listening on {bind_host}:{current_port}", flush=True)
    if bind_host not in ("127.0.0.1", "localhost", "::1"):
        print(f"pi-pymol: on the remote pi machine run:", flush=True)
        print(f"  export PI_PYMOL_TOKEN={get_token()}", flush=True)
        print(f"  /pymol {bind_host}:{current_port}", flush=True)
        print("pi-pymol: (the exec op is remote code execution — tailnet-only, "
              "never 0.0.0.0 on shared networks)", flush=True)
    else:
        print("pi-pymol: in your pi session, run: /pymol", flush=True)


def pi_pymol_stop() -> None:
    global socket_server, listening, current_port
    if socket_server:
        socket_server.stop()
    if listening:
        _remove_session_file(current_port)
    socket_server = None
    listening = False
    current_port = DEFAULT_PORT
    print("pi-pymol: bridge stopped")


try:
    from pymol import cmd as _cmd_ext
    _cmd_ext.extend("pi_pymol_start", pi_pymol_start)
    _cmd_ext.extend("pi_pymol_stop", pi_pymol_stop)
except Exception:
    pass  # headless runners can still use SocketServer directly


# ─────────────────────────────────────────────────────────────────────────────
# PLUGIN (PyMOL menu / dialog hooks)
# ─────────────────────────────────────────────────────────────────────────────

dialog: Any = None
socket_server: SocketServer | None = None
listening: bool = False
current_port: int = DEFAULT_PORT


def __init_plugin__(app: Any = None) -> None:  # noqa: ARG001 -- PyMOL passes the app arg
    from pymol.plugins import addmenuitemqt

    addmenuitemqt("pi-pymol", run_plugin_gui)


def run_plugin_gui() -> None:
    global dialog
    if dialog is None:
        dialog = make_dialog()
    dialog.show()


def make_dialog() -> Any:
    from pymol.Qt import QtWidgets
    from pymol.Qt.utils import loadUi

    dlg = QtWidgets.QDialog()
    uifile = Path(__file__).parent / "plugin.ui"
    form = loadUi(uifile, dlg)
    form.input_port.setValue(current_port)
    _set_status(form, "Not listening")

    def toggle_listening() -> None:
        global socket_server, listening, current_port
        if not listening:
            current_port = form.input_port.value()
            socket_server = SocketServer(port=current_port)
            if socket_server.start():
                listening = True
                form.button_toggle_listening.setText("Stop Listening")
                _set_status(form, f"Listening on port {current_port}")
        else:
            if socket_server:
                socket_server.stop()
            listening = False
            form.button_toggle_listening.setText("Start Listening")
            _set_status(form, "Not listening")

    def close_dialog() -> None:
        global socket_server, listening
        if socket_server and listening:
            socket_server.stop()
            listening = False
        dlg.close()

    form.button_toggle_listening.clicked.connect(toggle_listening)
    form.button_close.clicked.connect(close_dialog)
    return dlg


def _set_status(form: Any, text: str) -> None:
    form.label_status.setText(text)
    if "Not listening" in text:
        form.label_status.setStyleSheet("color: red;")
    elif "Listening" in text:
        form.label_status.setStyleSheet("color: green;")
    else:
        form.label_status.setStyleSheet("")
