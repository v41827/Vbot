"""Live coaching tips during training mode using a local Ollama model.

Called periodically with the rolling transcript and recent volume. Returns a
short tip (or None) to fade into the training UI.
"""
from __future__ import annotations

import json
import logging
import os
import time

from ollama import AsyncClient

from .protocols import LiveCoachingTip

log = logging.getLogger(__name__)

_SYSTEM = """You coach a speaker in real time during a short training session.

You are given: the rolling transcript so far, the most recent volume samples in dBFS, and an ambient dBFS baseline.

If there is something genuinely worth flagging right now (pace, energy, clarity, breathing, filler words, emotional tone), return a single short tip. Otherwise return an empty tip.

Rules:
- 8 words or fewer per tip.
- Friendly, imperative, sentence case, UK English, no em dashes.
- No repetition of earlier tips unless clearly relevant again.
- Never shame.

Return ONLY JSON: {"tip": "...", "category": "pace|volume|clarity|presence|emotion|general"}. Use empty string for "tip" if nothing is worth saying."""


class OllamaLiveCoaching:
    def __init__(
        self,
        host: str | None = None,
        model: str = "gemma4:e4b",
        max_tokens: int = 120,
        max_tip_chars: int = 70,
    ):
        self.host = host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.model = model
        self.max_tokens = max_tokens
        self.max_tip_chars = max_tip_chars
        self._client: AsyncClient | None = None
        self._last_tip_text: str = ""

    def _client_inst(self) -> AsyncClient:
        if self._client is None:
            self._client = AsyncClient(host=self.host)
        return self._client

    async def next_tip(
        self,
        rolling_transcript: str,
        recent_volume: list[float],
        ambient_dbfs: float,
    ) -> LiveCoachingTip | None:
        if not rolling_transcript.strip():
            return None

        client = self._client_inst()
        payload = {
            "transcript": rolling_transcript[-1200:],
            "recent_volume_dbfs": [round(v, 1) for v in recent_volume[-40:]],
            "ambient_dbfs": round(ambient_dbfs, 1),
            "previous_tip": self._last_tip_text,
        }

        try:
            resp = await client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": json.dumps(payload)},
                ],
                options={"num_predict": self.max_tokens, "temperature": 0.5},
                format="json",
            )
            raw = _message_content(resp)
            data = _parse_json_object(raw)
        except Exception as exc:
            log.warning("live coaching failed: %s", exc)
            return None

        tip_text = str(data.get("tip", "")).strip()
        if not tip_text:
            return None
        if tip_text == self._last_tip_text:
            return None
        if len(tip_text) > self.max_tip_chars:
            tip_text = tip_text[: self.max_tip_chars].rstrip()

        self._last_tip_text = tip_text
        return LiveCoachingTip(
            t=time.monotonic(),
            text=tip_text,
            category=str(data.get("category", "general")),
        )


def _message_content(resp) -> str:
    try:
        return resp["message"]["content"] or ""
    except (KeyError, TypeError):
        pass
    msg = getattr(resp, "message", None)
    if msg is None:
        return ""
    content = getattr(msg, "content", None)
    return content or ""


def _parse_json_object(raw: str) -> dict:
    raw = (raw or "").strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1:
        return {}
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return {}
