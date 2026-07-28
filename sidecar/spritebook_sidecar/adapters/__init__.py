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


def validate_params(
    schema: dict[str, Any],
    params: dict[str, Any],
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply ``defaults`` then check ``params`` against the adapter's OWN schema.

    Core validates params against the announced ``paramsSchema`` before a job
    request exists, so this is the second lock on the same door: a sidecar
    driven directly (selftest, a future CLI, a core bug) must still refuse
    nonsense with ``bad-params`` rather than crash halfway through a run.

    Supports exactly the JSON Schema subset the adapters here use — ``required``,
    ``additionalProperties: false``, and per-property ``type`` (string / integer
    / number / boolean), ``enum``, ``minimum``, ``maximum``, ``minLength``.
    Anything richer belongs in core, which has a real validator.
    """
    merged: dict[str, Any] = dict(defaults or {})
    merged.update(params)
    props: dict[str, Any] = schema.get("properties", {})

    if schema.get("additionalProperties") is False:
        unknown = sorted(set(merged) - set(props))
        if unknown:
            raise AdapterError(
                "bad-params",
                f"unknown param(s) {', '.join(unknown)}; allowed: {', '.join(sorted(props))}",
                False,
            )
    for key in schema.get("required", []):
        if key not in merged:
            raise AdapterError("bad-params", f"missing required param '{key}'", False)

    for key, spec in props.items():
        if key not in merged:
            continue
        value = merged[key]
        want = spec.get("type")
        # bool is a subclass of int in Python; an integer param must not accept True.
        if want == "integer":
            good = isinstance(value, int) and not isinstance(value, bool)
        elif want == "number":
            good = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif want == "string":
            good = isinstance(value, str)
        elif want == "boolean":
            good = isinstance(value, bool)
        else:
            good = True
        if not good:
            raise AdapterError(
                "bad-params",
                f"param '{key}' must be a {want}, got {type(value).__name__}",
                False,
            )
        if "enum" in spec and value not in spec["enum"]:
            allowed = ", ".join(str(v) for v in spec["enum"])
            raise AdapterError(
                "bad-params", f"param '{key}' must be one of [{allowed}], got {value!r}", False
            )
        if "minimum" in spec and value < spec["minimum"]:
            raise AdapterError(
                "bad-params", f"param '{key}' must be >= {spec['minimum']}, got {value}", False
            )
        if "maximum" in spec and value > spec["maximum"]:
            raise AdapterError(
                "bad-params", f"param '{key}' must be <= {spec['maximum']}, got {value}", False
            )
        if "minLength" in spec and len(value) < spec["minLength"]:
            raise AdapterError(
                "bad-params", f"param '{key}' must be at least {spec['minLength']} char(s)", False
            )
    return merged


@dataclass(frozen=True)
class Adapter:
    id: str
    kind: str  # a registry Capability, or 'test' (sidecar.ts SidecarAdapterSchema)
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
    from . import (
        echo,
        fixture_gen,
        fixture_retexture,
        pose_check,
        rembg_cutout,
        texture_substage,
        trellis2,
        trellis2_retexture,
        unirig,
    )

    adapters = [
        echo.ADAPTER,
        rembg_cutout.ADAPTER,
        pose_check.ADAPTER,
        fixture_gen.ADAPTER,
        fixture_retexture.ADAPTER,
        trellis2.ADAPTER,
        trellis2_retexture.ADAPTER,
        texture_substage.ADAPTER,
        unirig.ADAPTER,
    ]
    registry: dict[str, Adapter] = {}
    for adapter in adapters:
        if adapter.id in registry:
            raise ValueError(f"duplicate adapter id: {adapter.id}")
        registry[adapter.id] = adapter
    return registry
