"""Adapter registry.

Each adapter declares ``id``, ``kind``, ``version``, ``params_schema`` (JSON
Schema draft 2020-12 subset), ``defaults``, ``description``, and a
``run(params, emit) -> None`` that emits progress/artifact/warn through the
:class:`~spritebook_sidecar.events.JobEmitter` and raises :class:`AdapterError`
on failure (the server converts it to the terminal ``error`` event).

Registration is import-light: no adapter module may import its model runtime
(rembg/onnxruntime) at module scope — heavy imports happen inside ``run`` so
``/handshake`` stays instant and works on machines without weights.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


class Emitter(Protocol):
    job_id: str

    def progress(self, step: str, done: int, total: int) -> None: ...
    def artifact(self, kind: str, path: str) -> None: ...
    def warn(self, code: str, message: str) -> None: ...


class AdapterError(Exception):
    """Raised by adapters on failure; the server maps it to an ``error`` event."""

    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = bool(retryable)


@dataclass(frozen=True)
class Adapter:
    id: str
    kind: str  # 'imageprep' | 'gen3d' | 'rig' | 'test' (sidecar.ts SidecarAdapterSchema)
    version: str
    params_schema: dict[str, Any]
    defaults: dict[str, Any]
    run: Callable[[dict[str, Any], Emitter], None]
    description: str = ""

    def handshake_entry(self) -> dict[str, Any]:
        """The SidecarAdapterSchema shape announced by GET /handshake."""
        entry: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "version": self.version,
            "paramsSchema": self.params_schema,
            "defaults": self.defaults,
        }
        if self.description:
            entry["description"] = self.description
        return entry


def build_registry() -> dict[str, Adapter]:
    """id -> Adapter, in announcement order."""
    from . import echo, pose_check, rembg_cutout

    adapters = [echo.ADAPTER, rembg_cutout.ADAPTER, pose_check.ADAPTER]
    registry: dict[str, Adapter] = {}
    for adapter in adapters:
        if adapter.id in registry:
            raise ValueError(f"duplicate adapter id: {adapter.id}")
        registry[adapter.id] = adapter
    return registry
