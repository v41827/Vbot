"""Biomarker extraction.

Primary path: thymia API (if configured).
Fallback: derive pace, filler rate from the transcript so coaching still works.
"""
from __future__ import annotations

import logging
import os
import re

import httpx

from .protocols import BiomarkerResult, TranscriptionResult

log = logging.getLogger(__name__)

_FILLERS = {"um", "uh", "er", "erm", "ah", "like", "you know", "sort of", "kind of"}


class ThymiaBiomarker:
    def __init__(
        self,
        api_key: str | None = None,
        api_base: str | None = None,
    ):
        self.api_key = api_key or os.getenv("THYMIA_API_KEY", "")
        self.api_base = (api_base or os.getenv("THYMIA_API_BASE", "https://api.thymia.ai")).rstrip("/")

    async def analyse(
        self,
        audio_path: str,
        transcript: TranscriptionResult,
    ) -> BiomarkerResult:
        fallback = _transcript_biomarkers(transcript)

        if not self.api_key:
            fallback.error = "missing THYMIA_API_KEY, used transcript fallback"
            return fallback

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                with open(audio_path, "rb") as f:
                    files = {"audio": (os.path.basename(audio_path), f, "audio/wav")}
                    headers = {"Authorization": f"Bearer {self.api_key}"}
                    resp = await client.post(
                        f"{self.api_base}/v1/analyse",
                        files=files,
                        headers=headers,
                    )
            if resp.status_code >= 400:
                log.warning("thymia returned %s: %s", resp.status_code, resp.text[:200])
                fallback.error = f"thymia {resp.status_code}, used transcript fallback"
                return fallback

            payload = resp.json()
        except Exception as exc:
            log.exception("thymia call failed")
            fallback.error = f"thymia error: {exc}, used transcript fallback"
            return fallback

        return _merge_thymia(payload, fallback)


def _transcript_biomarkers(transcript: TranscriptionResult) -> BiomarkerResult:
    if not transcript.words or transcript.duration_seconds <= 0:
        return BiomarkerResult()

    total_words = len(transcript.words)
    minutes = transcript.duration_seconds / 60.0
    pace = total_words / minutes if minutes > 0 else None

    lowered = transcript.text.lower()
    filler_hits = 0
    for token in _FILLERS:
        filler_hits += len(re.findall(rf"\b{re.escape(token)}\b", lowered))
    filler_rate = filler_hits / total_words if total_words else 0.0

    return BiomarkerResult(pace_wpm=pace, filler_rate=filler_rate)


def _merge_thymia(payload: dict, fallback: BiomarkerResult) -> BiomarkerResult:
    out = BiomarkerResult(
        pace_wpm=_safe_float(payload.get("pace_wpm", fallback.pace_wpm)),
        filler_rate=_safe_float(payload.get("filler_rate", fallback.filler_rate)),
        pitch_mean_hz=_safe_float(payload.get("pitch_mean_hz")),
        pitch_variability=_safe_float(payload.get("pitch_variability")),
        jitter=_safe_float(payload.get("jitter")),
        shimmer=_safe_float(payload.get("shimmer")),
        extra={k: v for k, v in payload.items() if k not in {
            "pace_wpm", "filler_rate", "pitch_mean_hz", "pitch_variability", "jitter", "shimmer"
        }},
    )
    return out


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None
