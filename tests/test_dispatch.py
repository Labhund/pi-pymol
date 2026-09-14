"""Dispatch-op tests against a real plugin server backed by FakeCmd.

Ported from Arcadia-Science/agentic-pymol (MIT); the `hello` tests are new —
the protocol handshake is a pi-pymol addition.
"""

from __future__ import annotations
from typing import Any

import pytest

from .conftest import FAKE_PYMOL_VERSION, TEST_TOKEN, FakeCmd, send_recv_raw


def _request(op: str, **fields: Any) -> dict[str, Any]:
    return {"op": op, "token": TEST_TOKEN, **fields}


def test_call_returns_serialized_value(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    host, port = running_plugin
    response = send_recv_raw(
        host, port, _request("call", fn="echo", args=[{"a": 1, "b": [2, 3]}], kwargs={})
    )
    assert response["ok"] is True
    assert response["value"] == {"a": 1, "b": [2, 3]}


def test_call_unknown_attribute_returns_attribute_error(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("call", fn="does_not_exist", args=[], kwargs={}))
    assert response["ok"] is False
    assert response["error"]["type"] == "AttributeError"


def test_call_invalid_identifier_rejected(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("call", fn="echo; rm -rf /", args=[], kwargs={}))
    assert response["ok"] is False
    assert response["error"]["type"] == "BadRequest"


def test_call_empty_fn_rejected(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("call", fn="", args=[], kwargs={}))
    assert response["ok"] is False
    assert response["error"]["type"] == "BadRequest"


def test_unknown_op_rejected(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("nonsense"))
    assert response["ok"] is False
    assert response["error"]["type"] == "BadRequest"


def test_hello_reports_protocol_and_versions(running_plugin: tuple[str, int]) -> None:
    """The handshake the TypeScript extension runs before its first real call."""
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("hello"))
    assert response["ok"] is True
    value = response["value"]
    assert value["protocol"] == 1
    assert value["plugin_version"] == "0.2.0"
    assert value["pymol_version"] == FAKE_PYMOL_VERSION


def test_hello_still_requires_auth(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, {"op": "hello"})
    assert response["ok"] is False
    assert response["error"]["type"] == "Unauthorized"


def test_exec_runs_code_and_returns_expression(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    host, port = running_plugin
    response = send_recv_raw(
        host,
        port,
        _request(
            "exec",
            code="result = cmd.echo(7) + cmd.echo(35)",
            return_expr="result",
        ),
    )
    assert response["ok"] is True
    assert response["value"] == 42
    assert fake_pymol.echo_calls == [7, 35]


def test_exec_without_return_expr_returns_none(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("exec", code="cmd.echo(99)", return_expr=None))
    assert response["ok"] is True
    assert response["value"] is None
    assert fake_pymol.echo_calls == [99]


def test_exec_propagates_python_error(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(
        host, port, _request("exec", code="raise ValueError('boom')", return_expr=None)
    )
    assert response["ok"] is False
    assert response["error"]["type"] == "ValueError"
    assert "boom" in response["error"]["message"]


def test_iterate_invalid_property_rejected(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(
        host,
        port,
        _request(
            "iterate",
            selection="all",
            properties=["resi; rm -rf /"],
            state=None,
        ),
    )
    assert response["ok"] is False
    assert response["error"]["type"] == "BadRequest"


def test_iterate_empty_properties_rejected(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(
        host,
        port,
        _request(
            "iterate",
            selection="all",
            properties=[],
            state=None,
        ),
    )
    assert response["ok"] is False
    assert response["error"]["type"] == "BadRequest"



def test_failing_do_reports_console_errors(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    """A command-language error prints to the PyMOL console without raising —
    the response must carry those console lines so the agent can react
    (2026-09-14: the agent iterated blind while the GUI console held the
    diagnosis)."""
    host, port = running_plugin
    fake_pymol.pending_feedback = [" Error: Unknown command: 'garbage_command_xyz'"]
    response = send_recv_raw(
        host, port, _request("call", fn="echo", args=["hi"], kwargs={})
    )
    assert response["ok"] is True
    assert "garbage_command_xyz" in "".join(response.get("console", []))


def test_quiet_op_returns_empty_console(running_plugin: tuple[str, int]) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, _request("call", fn="echo", args=["hi"], kwargs={}))
    assert response["ok"] is True
    assert response.get("console") == []


def test_nameerror_returns_clean_error_without_killing_connection(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    """The 2026-09-14 live cascade: a NameError whose traceback formatting
    itself crashed (Python 3.14 suggestion machinery vs PyMOL Wrapper locals)
    killed the client-handler thread. The op must return an error envelope
    and the connection must survive."""
    host, port = running_plugin
    response = send_recv_raw(
        host, port, _request("exec", code="cmd.iterate_state(-1, 'all', 'coord[2]')", return_expr=None)
    )
    assert response["ok"] is False
    assert response["error"]["type"] in ("NameError", "TypeError")
    # connection was closed by send_recv_raw; the server must accept a new one
    response2 = send_recv_raw(host, port, _request("call", fn="echo", args=["alive"], kwargs={}))
    assert response2["ok"] is True


def test_formatting_failure_cannot_kill_handler(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even when traceback formatting itself explodes, the response must be a
    clean error envelope with a usable message, and the next request must work."""
    import pi_pymol_plugin as plugin  # loaded via conftest import machinery

    # simulate the 3.14 suggestion crash: format_exc raises
    import traceback as _tb

    real = _tb.format_exc

    def boom() -> str:
        raise TypeError("'wrapper.Wrapper' object is not iterable")

    monkeypatch.setattr(_tb, "format_exc", boom)
    host, port = running_plugin
    response = send_recv_raw(
        host, port, _request("exec", code="raise NameError('coord')", return_expr=None)
    )
    monkeypatch.setattr(_tb, "format_exc", real)
    assert response["ok"] is False
    assert response["error"]["type"] == "NameError"
    assert "NameError: coord" in response["error"]["traceback"]
    # still healthy
    ok = send_recv_raw(host, port, _request("call", fn="echo", args=["x"], kwargs={}))
    assert ok["value"] == "x"
