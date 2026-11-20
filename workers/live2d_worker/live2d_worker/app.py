from __future__ import annotations

from typing import Any

from .pipeline import WorkerConfig, inspect_runtime, run_generation

try:
    from fastapi import FastAPI, HTTPException
except ImportError as exc:  # pragma: no cover - imported only by uvicorn deployments.
    raise RuntimeError("Install workers/live2d_worker/requirements.txt to use the FastAPI worker.") from exc

config = WorkerConfig.from_env()
app = FastAPI(title="AI-Lover Local Live2D Worker", version="1.7.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "worker": "live2d-local-worker",
        "publicRoot": str(config.public_root),
        "publicBase": config.public_base,
        "returnTemplate": config.return_template,
        "riggingEndpointConfigured": bool(config.rigging_endpoint),
        "cubismBridgeConfigured": bool(config.cubism_bridge_command),
        "runtime": inspect_runtime(),
    }


@app.post("/live2d/generate")
def generate(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return run_generation(payload, config)
    except Exception as exc:  # noqa: BLE001 - API boundary serializes worker failures.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

