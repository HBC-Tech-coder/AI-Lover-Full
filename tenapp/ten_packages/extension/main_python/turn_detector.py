import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib import request


@dataclass
class TurnDetectionResult:
    decision: str
    confidence: float = 0.0
    source: str = "disabled"
    raw: dict[str, Any] | None = None


class TurnDetector:
    """Small adapter for TEN Turn Detection style decisions.

    The official TEN Turn Detection model returns one of three labels:
    finished, unfinished, or wait. This adapter can call an HTTP worker that
    exposes that model and falls back to conservative punctuation/filler rules
    when the worker is unavailable or not configured.
    """

    _UNFINISHED_ZH_SUFFIXES = (
        "然后",
        "因为",
        "但是",
        "不过",
        "如果",
        "假如",
        "比如",
        "例如",
        "还有",
        "以及",
        "或者",
        "还是",
        "就是",
        "那个",
        "这个",
        "我想",
        "你能",
        "你可以",
        "首先",
        "第一",
        "第二",
        "第三",
    )
    _WAIT_ZH = ("嗯", "呃", "啊", "那个", "这个", "等一下")
    _UNFINISHED_EN_RE = re.compile(
        r"\b(and|but|because|if|when|while|so|then|like|or|also|first|second|third|i want to|can you|could you)\s*$",
        re.IGNORECASE,
    )

    def __init__(
        self,
        endpoint: str = "",
        timeout_ms: int = 800,
        fallback_rules: bool = True,
    ):
        self.endpoint = (endpoint or "").strip()
        if self.endpoint.startswith("${env:"):
            self.endpoint = ""
        self.timeout = max(0.1, timeout_ms / 1000)
        self.fallback_rules = fallback_rules

    async def detect(
        self,
        text: str,
        history: list[dict[str, str]] | None = None,
        language: str | None = None,
    ) -> TurnDetectionResult:
        text = (text or "").strip()
        if not text:
            return TurnDetectionResult("wait", 1.0, "empty")

        if self.endpoint:
            result = await self._detect_remote(text, history or [], language)
            if result.decision != "unknown":
                return result

        if self.fallback_rules:
            return self._detect_fallback(text)

        return TurnDetectionResult("finished", 0.0, "default")

    async def _detect_remote(
        self,
        text: str,
        history: list[dict[str, str]],
        language: str | None,
    ) -> TurnDetectionResult:
        payload = json.dumps(
            {
                "text": text,
                "history": history[-6:],
                "language": language or "auto",
            }
        ).encode("utf-8")

        def _post() -> TurnDetectionResult:
            req = request.Request(
                self.endpoint,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            data = json.loads(body)
            decision = self._normalize_decision(data)
            confidence = self._extract_confidence(data)
            return TurnDetectionResult(
                decision=decision,
                confidence=confidence,
                source="ten-turn-detection-http",
                raw=data,
            )

        try:
            return await asyncio.to_thread(_post)
        except Exception as exc:
            return TurnDetectionResult(
                decision="unknown",
                source="ten-turn-detection-http-error",
                raw={"error": str(exc)},
            )

    def _detect_fallback(self, text: str) -> TurnDetectionResult:
        compact = re.sub(r"\s+", " ", text).strip()
        if compact in self._WAIT_ZH or compact.lower() in {"um", "uh", "hmm"}:
            return TurnDetectionResult("wait", 0.75, "fallback")

        if compact.endswith(("，", "、", "；", ",", ";", "：", ":")):
            return TurnDetectionResult("unfinished", 0.65, "fallback")

        if any(compact.endswith(suffix) for suffix in self._UNFINISHED_ZH_SUFFIXES):
            return TurnDetectionResult("unfinished", 0.7, "fallback")

        if self._UNFINISHED_EN_RE.search(compact):
            return TurnDetectionResult("unfinished", 0.68, "fallback")

        return TurnDetectionResult("finished", 0.55, "fallback")

    @staticmethod
    def _normalize_decision(data: Any) -> str:
        if isinstance(data, str):
            value = data
        elif isinstance(data, dict):
            value = (
                data.get("decision")
                or data.get("label")
                or data.get("prediction")
                or data.get("turn_status")
                or data.get("status")
                or data.get("result")
            )
            if isinstance(value, dict):
                value = (
                    value.get("decision")
                    or value.get("label")
                    or value.get("prediction")
                    or value.get("turn_status")
                )
        else:
            value = None
        normalized = str(value or "").strip().lower().replace("-", "_")
        aliases = {
            "complete": "finished",
            "completed": "finished",
            "end": "finished",
            "stop": "finished",
            "incomplete": "unfinished",
            "continue": "unfinished",
            "not_finished": "unfinished",
            "listen": "wait",
            "waiting": "wait",
        }
        return aliases.get(normalized, normalized if normalized in {"finished", "unfinished", "wait"} else "unknown")

    @staticmethod
    def _extract_confidence(data: Any) -> float:
        if not isinstance(data, dict):
            return 0.0
        value = data.get("confidence") or data.get("score") or data.get("probability")
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0
