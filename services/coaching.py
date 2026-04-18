"""Post-session coaching report generator using a local Ollama model."""
from __future__ import annotations

import json
import logging
import os
import statistics

from ollama import AsyncClient

from .protocols import (
    BiomarkerResult,
    CoachingReport,
    CoachingTip,
    EmotionResult,
    TranscriptionResult,
)

log = logging.getLogger(__name__)

_SYSTEM = """You are a warm, practical vocal coach.

You receive a short training session: a transcript, an emotion timeline, biomarkers, and a volume timeline (dBFS). Your job is to give the speaker 3 concrete, specific tips they can apply next time.

Return ONLY a JSON object with this shape:
{
  "summary": "one or two sentences capturing the session",
  "score": integer 0-100,
  "strengths": ["short strength 1", "short strength 2"],
  "tips": [
    {"category": "volume|pace|emotion|clarity|presence", "text": "actionable tip, specific, friendly"}
  ]
}

Rules:
- Sentence case. No em dashes.
- Be specific. Quote short phrases from the transcript where useful.
- Never shame. Frame everything as an invitation.
- UK English."""


class OllamaCoaching:
    def __init__(
        self,
        host: str | None = None,
        model: str = "gemma4:e4b",
        max_tokens: int = 1200,
    ):
        self.host = host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.model = model
        self.max_tokens = max_tokens
        self._client: AsyncClient | None = None

    def _client_inst(self) -> AsyncClient:
        if self._client is None:
            self._client = AsyncClient(host=self.host)
        return self._client

    async def generate_report(
        self,
        transcript: TranscriptionResult,
        emotion: EmotionResult,
        biomarker: BiomarkerResult,
        volume_timeline: list[dict[str, float]],
    ) -> CoachingReport:
        import time as _time
        client = self._client_inst()
        volume_stats = _volume_stats(volume_timeline)
        payload = {
            "transcript": transcript.text,
            "duration_seconds": transcript.duration_seconds,
            "word_count": len(transcript.words),
            "emotion_dominant": emotion.dominant,
            "emotion_timeline": [
                {"t": round(p.t, 2), "label": p.label, "valence": round(p.valence, 2), "arousal": round(p.arousal, 2)}
                for p in emotion.timeline
            ],
            "biomarker": biomarker.to_dict(),
            "volume_stats": volume_stats,
        }
        serialized = json.dumps(payload)
        log.info(
            "[coaching] calling ollama model=%s num_predict=%d payload_len=%d transcript_len=%d",
            self.model, self.max_tokens, len(serialized), len(transcript.text or ""),
        )

        started = _time.monotonic()
        try:
            resp = await client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": serialized},
                ],
                options={"num_predict": self.max_tokens, "temperature": 0.4},
                format="json",
            )
            raw = _message_content(resp)
            log.info("[coaching] ollama response in %.1fs, raw_len=%d preview=%r",
                     _time.monotonic() - started, len(raw), raw[:200])
            data = _parse_json_object(raw)
            log.info("[coaching] parsed keys=%s tips=%d score=%s",
                     list(data.keys()), len(data.get("tips", []) or []), data.get("score"))
        except Exception as exc:
            log.exception("[coaching] ollama coaching failed after %.1fs", _time.monotonic() - started)
            return CoachingReport(summary="", error=str(exc))

        tips = [
            CoachingTip(category=str(t.get("category", "general")), text=str(t.get("text", "")))
            for t in data.get("tips", [])
            if t.get("text")
        ]
        return CoachingReport(
            summary=str(data.get("summary", "")),
            tips=tips,
            score=int(data.get("score", 0) or 0),
            strengths=[str(s) for s in data.get("strengths", []) if s],
        )


def _volume_stats(timeline: list[dict[str, float]]) -> dict:
    if not timeline:
        return {"points": 0}
    values = [p.get("dbfs", -100.0) for p in timeline if isinstance(p, dict)]
    if not values:
        return {"points": 0}
    return {
        "points": len(values),
        "mean": round(statistics.fmean(values), 2),
        "max": round(max(values), 2),
        "min": round(min(values), 2),
        "stdev": round(statistics.pstdev(values), 2) if len(values) > 1 else 0.0,
    }


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
