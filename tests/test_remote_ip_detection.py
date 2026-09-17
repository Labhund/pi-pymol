"""
Tests for `_detect_remote_ip` and `_is_tailnet_ip`: the bridge must bind a
tailnet (CGNAT 100.64.0.0/10) address or refuse — never a LAN IP. The LAN-IP
failure mode is real: a macOS GUI install answered the UDP route probe with
the en0 address when magic-DNS UDP was filtered (2026-09-15).
"""

from __future__ import annotations

import types
from typing import Any

import pytest

from .conftest import plugin_module  # noqa: F401


class TestIsTailnetIp:
    def test_accepts_cgnat_range(self, plugin_module: Any) -> None:
        assert plugin_module._is_tailnet_ip("100.94.211.125")
        assert plugin_module._is_tailnet_ip("100.64.0.1")
        assert plugin_module._is_tailnet_ip("100.127.255.254")

    def test_rejects_lan_loopback_and_garbage(self, plugin_module: Any) -> None:
        assert not plugin_module._is_tailnet_ip("10.136.108.249")
        assert not plugin_module._is_tailnet_ip("192.168.1.5")
        assert not plugin_module._is_tailnet_ip("127.0.0.1")
        assert not plugin_module._is_tailnet_ip("")
        assert not plugin_module._is_tailnet_ip("not-an-ip")

    def test_rejects_cgnat_neighbors(self, plugin_module: Any) -> None:
        assert not plugin_module._is_tailnet_ip("100.63.255.255")
        assert not plugin_module._is_tailnet_ip("100.128.0.0")


class TestDetectRemoteIp:
    def test_cli_path_wins_when_it_answers(self, plugin_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[list[str]] = []

        class FakeCompleted:
            returncode = 0
            stdout = "100.94.211.125\n"

        def fake_run(argv: list[str], **kw: Any) -> FakeCompleted:
            calls.append(argv)
            return FakeCompleted()

        # _detect_remote_ip imports subprocess locally, so patch the stdlib module.
        import subprocess as subprocess_mod

        monkeypatch.setattr(subprocess_mod, "run", fake_run)
        assert plugin_module._detect_remote_ip() == "100.94.211.125"
        assert calls and calls[0][0] == "tailscale"

    def test_lan_ip_from_probe_is_refused(self, plugin_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        # No CLI anywhere.
        import subprocess as subprocess_mod

        def no_cli(argv: list[str], **kw: Any) -> Any:
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(subprocess_mod, "run", no_cli)

        class FakeSocket:
            def connect(self, addr: Any) -> None:
                pass

            def getsockname(self) -> tuple[str, int]:
                return ("10.136.108.249", 0)  # what the uni-network Mac returned

            def close(self) -> None:
                pass

        monkeypatch.setattr(plugin_module.socket, "socket", lambda *a: FakeSocket())
        # The dev machine may hold a real tailnet interface; pretend none exists.
        monkeypatch.setattr(plugin_module, "_tailnet_ip_from_interfaces", lambda: "")
        with pytest.raises(RuntimeError, match="Could not detect a tailnet address"):
            plugin_module._detect_remote_ip()

    def test_interface_fallback_rescues_dead_probe(self, plugin_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        # No CLI, probe errors outright (the 2026-09-18 Mac), but ifconfig
        # shows the utun tailnet address.
        import subprocess as subprocess_mod

        calls: list[list[str]] = []

        def fake_run(argv: list[str], **kw: Any) -> Any:
            calls.append(argv)
            if argv[0] == "ifconfig":
                out = types.SimpleNamespace()
                out.returncode = 0
                out.stdout = (
                    "en0: flags=8863<UP> mtu 1500\n"
                    "\tinet 10.136.108.249 netmask 0xffff0000 broadcast 10.136.255.255\n"
                    "utun4: flags=8051<UP> mtu 1380\n"
                    "\tinet 100.94.211.125 --> 100.94.211.125 netmask 0xff800000\n"
                )
                return out
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(subprocess_mod, "run", fake_run)

        class DeadSocket:
            def connect(self, addr: Any) -> None:
                raise OSError("no route")

            def close(self) -> None:
                pass

        monkeypatch.setattr(plugin_module.socket, "socket", lambda *a: DeadSocket())
        assert plugin_module._detect_remote_ip() == "100.94.211.125"
        assert any(c[0] == "ifconfig" for c in calls)

    def test_no_cli_no_route_no_interface_raises(self, plugin_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        import subprocess as subprocess_mod

        def no_cli(argv: list[str], **kw: Any) -> Any:
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(subprocess_mod, "run", no_cli)

        class DeadSocket:
            def connect(self, addr: Any) -> None:
                raise OSError("no route")

            def close(self) -> None:
                pass

        monkeypatch.setattr(plugin_module.socket, "socket", lambda *a: DeadSocket())
        monkeypatch.setattr(plugin_module, "_tailnet_ip_from_interfaces", lambda: "")
        with pytest.raises(RuntimeError, match="Could not detect a tailnet address"):
            plugin_module._detect_remote_ip()
