"""
Tests for the cancellation path (plugin side).

`test_op_interrupt_calls_cmd_interrupt` exercises the plugin's `op="interrupt"`
handler; `test_interrupt_works_concurrently_with_in_flight_call` checks the
server accepts a fresh connection for interrupt while a worker is busy.

The client-side counterpart — a call that exceeds the client timeout must fire
`op="interrupt"` on a side channel and surface TransportTimeout, while a plain
transport error must NOT interrupt — is tested against the real TypeScript
client in `extension/client.test.ts` (upstream tested its Python MCP client;
ours is the pi extension's client).

Ported from Arcadia-Science/agentic-pymol (MIT).
"""

from __future__ import annotations
import threading
import time
from typing import Any

from .conftest import TEST_TOKEN, FakeCmd, send_recv_raw


def test_op_interrupt_calls_cmd_interrupt(
    running_plugin: tuple[str, int], fake_pymol: FakeCmd
) -> None:
    host, port = running_plugin
    response = send_recv_raw(host, port, {"op": "interrupt", "token": TEST_TOKEN})
    assert response["ok"] is True
    assert fake_pymol.interrupted.wait(timeout=1.0)
    assert fake_pymol.interrupt_calls == 1


def test_interrupt_works_concurrently_with_in_flight_call(
    running_plugin: tuple[str, int],
    fake_pymol: FakeCmd,
) -> None:
    """The plugin must accept a fresh connection for op=interrupt while another worker is busy."""
    host, port = running_plugin

    slow_done = threading.Event()
    slow_response: dict[str, Any] = {}

    def fire_slow() -> None:
        slow_response.update(
            send_recv_raw(
                host,
                port,
                {
                    "op": "call",
                    "fn": "slow",
                    "args": [],
                    "kwargs": {"duration": 0.3},
                    "token": TEST_TOKEN,
                },
                timeout=5.0,
            )
        )
        slow_done.set()

    t = threading.Thread(target=fire_slow, daemon=True)
    t.start()

    time.sleep(0.05)

    interrupt_response = send_recv_raw(host, port, {"op": "interrupt", "token": TEST_TOKEN})
    assert interrupt_response["ok"] is True
    assert fake_pymol.interrupt_calls == 1

    assert slow_done.wait(timeout=2.0)
    assert slow_response.get("ok") is True
    assert slow_response.get("value") == "done"
