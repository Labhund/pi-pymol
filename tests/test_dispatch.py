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
    assert value["plugin_version"] == "0.1.3"
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
