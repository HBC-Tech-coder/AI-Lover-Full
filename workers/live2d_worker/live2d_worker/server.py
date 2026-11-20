from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .pipeline import WorkerConfig, inspect_runtime, run_generation


class Live2DWorkerHandler(BaseHTTPRequestHandler):
    config: WorkerConfig

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API.
        self._send_json({"ok": True})

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API.
        if self.path.rstrip("/") == "/health":
            self._send_json(
                {
                    "ok": True,
                    "worker": "live2d-local-worker",
                    "publicRoot": str(self.config.public_root),
                    "publicBase": self.config.public_base,
                    "returnTemplate": self.config.return_template,
                    "riggingEndpointConfigured": bool(self.config.rigging_endpoint),
                    "cubismBridgeConfigured": bool(self.config.cubism_bridge_command),
                    "runtime": inspect_runtime(),
                }
            )
            return
        self._send_json({"ok": False, "error": "not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API.
        if self.path.rstrip("/") != "/live2d/generate":
            self._send_json({"ok": False, "error": "not found"}, status=HTTPStatus.NOT_FOUND)
            return

        try:
            content_length = int(self.headers.get("content-length") or "0")
            if content_length <= 0:
                raise ValueError("empty request body")
            raw = self.rfile.read(content_length).decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            result = run_generation(payload, self.config)
            self._send_json(result)
        except Exception as exc:  # noqa: BLE001 - worker boundary should serialize all errors.
            self._send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib API.
        print(f"[live2d-worker] {self.address_string()} {format % args}")

    def _send_json(self, body: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type,authorization")
        self.end_headers()
        self.wfile.write(data)


def make_handler(config: WorkerConfig) -> type[Live2DWorkerHandler]:
    class ConfiguredLive2DWorkerHandler(Live2DWorkerHandler):
        pass

    ConfiguredLive2DWorkerHandler.config = config
    return ConfiguredLive2DWorkerHandler


def main() -> None:
    config = WorkerConfig.from_env()
    host = os.environ.get("LIVE2D_WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("LIVE2D_WORKER_PORT", "8790"))
    config.public_root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), make_handler(config))
    print(f"[live2d-worker] listening on http://{host}:{port}")
    print(f"[live2d-worker] output public root: {config.public_root}")
    print(f"[live2d-worker] return template model: {config.return_template}")
    server.serve_forever()


if __name__ == "__main__":
    main()

