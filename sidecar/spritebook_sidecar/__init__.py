"""SpriteBook Python sidecar (P3-T2).

Local, per-session process owned by core. The wire contract is FROZEN in
``packages/schema/sidecar.ts``; the constants here mirror it exactly.
"""

SIDECAR_VERSION = "0.1.0"
SIDECAR_CONTRACT_VERSION = 1
SIDECAR_TOKEN_ENV = "SPRITEBOOK_SIDECAR_TOKEN"
