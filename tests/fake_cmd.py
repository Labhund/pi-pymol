"""
Shared FakeCmd stand-in for `pymol.cmd`, used by the pytest suite (via
conftest) and by fake_pymol_server.py (the harness the TypeScript client
integration tests drive). Ported from Arcadia-Science/agentic-pymol (MIT).
"""

from __future__ import annotations
import struct
import threading
import time
from pathlib import Path
from typing import Any

TEST_TOKEN = "test-token-1234567890abcdef"
FAKE_PYMOL_VERSION = "3.1.0"
LENGTH_HEADER = struct.Struct(">I")


class FakeCmd:
    """
    Minimal stand-in for `pymol.cmd` used by tests.

    Every method appends a `(name, args, kwargs)` tuple to `self.calls` so
    tests can assert on dispatch arguments. Return values default to realistic
    PyMOL shapes; individual tests override via attributes like
    `fake_cmd.align_return = (...)` before invoking.
    """

    def __init__(self) -> None:
        self.interrupted = threading.Event()
        self.interrupt_calls = 0
        self.echo_calls: list[Any] = []
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.iterate_rows: list[dict[str, Any]] = []
        self.align_return: tuple[Any, ...] = (1.5, 100, 5, 2.5, 120, 800.0, 95)
        self.super_return: tuple[Any, ...] = (0.8, 80, 5, 1.2, 90, 750.0, 88)
        self.cealign_return: dict[str, Any] = {
            "RMSD": 2.3,
            "alignment_length": 75,
            "rotation_matrix": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
        self.rms_return: float = 1.1
        self.rms_cur_return: float = 0.9
        self.alter_return: int = 42
        self.get_model_return: dict[str, Any] = {
            "_kind": "model",
            "atoms": [{"name": "CA", "resi": "1"}],
            "n_atoms": 1,
        }
        self.get_fastastr_return: str = ">obj_A\nMKL\n"
        self.get_distance_return: float = 3.8
        self.get_extent_return: list[list[float]] = [[-1.0, -2.0, -3.0], [4.0, 5.0, 6.0]]
        self.get_object_list_return: list[str] = ["obj1", "obj2"]
        self.get_names_return: list[str] = ["sel1"]
        self.get_chains_return: list[str] = ["A", "B"]
        self.count_atoms_return: int = 500
        self.count_states_return: int = 10
        self.get_view_return: list[float] = [float(i) for i in range(18)]
        self.get_coords_return: list[list[float]] | None = [[0.0, 1.0, 2.0], [3.0, 4.0, 5.0]]
        self.get_frame_return: int = 7
        self.get_state_return: int = 3
        self.get_version_return: str = FAKE_PYMOL_VERSION
        self.png_payload: bytes = b"\x89PNG\r\n\x1a\nfake-png-bytes"

    def _record(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        self.calls.append((name, args, kwargs))

    def interrupt(self) -> None:
        self.interrupt_calls += 1
        self.interrupted.set()

    def echo(self, x: Any) -> Any:
        self.echo_calls.append(x)
        return x

    def slow(self, duration: float = 0.5) -> str:
        time.sleep(duration)
        return "done"

    def align(self, *args: Any, **kwargs: Any) -> tuple[Any, ...]:
        self._record("align", args, kwargs)
        return self.align_return

    def super(self, *args: Any, **kwargs: Any) -> tuple[Any, ...]:
        self._record("super", args, kwargs)
        return self.super_return

    def cealign(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self._record("cealign", args, kwargs)
        return self.cealign_return

    def rms(self, *args: Any, **kwargs: Any) -> float:
        self._record("rms", args, kwargs)
        return self.rms_return

    def rms_cur(self, *args: Any, **kwargs: Any) -> float:
        self._record("rms_cur", args, kwargs)
        return self.rms_cur_return

    def iterate(self, selection: str, expression: str, space: dict[str, Any]) -> int:
        self._record("iterate", (selection, expression), {})
        for row in self.iterate_rows:
            space["_acc"].append(dict(row))
        return len(self.iterate_rows)

    def iterate_state(
        self, state: int, selection: str, expression: str, space: dict[str, Any]
    ) -> int:
        self._record("iterate_state", (state, selection, expression), {})
        for row in self.iterate_rows:
            space["_acc"].append(dict(row))
        return len(self.iterate_rows)

    def alter(self, *args: Any, **kwargs: Any) -> int:
        self._record("alter", args, kwargs)
        return self.alter_return

    def get_model(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self._record("get_model", args, kwargs)
        return self.get_model_return

    def get_fastastr(self, *args: Any, **kwargs: Any) -> str:
        self._record("get_fastastr", args, kwargs)
        return self.get_fastastr_return

    def fetch(self, *args: Any, **kwargs: Any) -> None:
        self._record("fetch", args, kwargs)

    def load(self, *args: Any, **kwargs: Any) -> None:
        self._record("load", args, kwargs)

    def save(self, *args: Any, **kwargs: Any) -> None:
        self._record("save", args, kwargs)

    def png(self, filename: str, *args: Any, **kwargs: Any) -> None:
        self._record("png", (filename, *args), kwargs)
        Path(filename).write_bytes(self.png_payload)

    def get_distance(self, *args: Any, **kwargs: Any) -> float:
        self._record("get_distance", args, kwargs)
        return self.get_distance_return

    def get_extent(self, *args: Any, **kwargs: Any) -> list[list[float]]:
        self._record("get_extent", args, kwargs)
        return self.get_extent_return

    def get_object_list(self, *args: Any, **kwargs: Any) -> list[str]:
        self._record("get_object_list", args, kwargs)
        return self.get_object_list_return

    def get_names(self, *args: Any, **kwargs: Any) -> list[str]:
        self._record("get_names", args, kwargs)
        return self.get_names_return

    def get_chains(self, *args: Any, **kwargs: Any) -> list[str]:
        self._record("get_chains", args, kwargs)
        return self.get_chains_return

    def count_atoms(self, *args: Any, **kwargs: Any) -> int:
        self._record("count_atoms", args, kwargs)
        return self.count_atoms_return

    def count_states(self, *args: Any, **kwargs: Any) -> int:
        self._record("count_states", args, kwargs)
        return self.count_states_return

    def get_view(self, *args: Any, **kwargs: Any) -> list[float]:
        self._record("get_view", args, kwargs)
        return self.get_view_return

    def set_view(self, *args: Any, **kwargs: Any) -> None:
        self._record("set_view", args, kwargs)

    def get_coords(self, *args: Any, **kwargs: Any) -> list[list[float]] | None:
        self._record("get_coords", args, kwargs)
        return self.get_coords_return

    def get_frame(self, *args: Any, **kwargs: Any) -> int:
        self._record("get_frame", args, kwargs)
        return self.get_frame_return

    def get_state(self, *args: Any, **kwargs: Any) -> int:
        self._record("get_state", args, kwargs)
        return self.get_state_return

    def get_version(self, *args: Any, **kwargs: Any) -> tuple[str]:
        self._record("get_version", args, kwargs)
        return (self.get_version_return,)

    def do(self, *args: Any, **kwargs: Any) -> None:
        self._record("do", args, kwargs)
        print(f"did: {args[0] if args else ''}")
