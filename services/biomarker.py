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
        log.info(
            "[thymia] analyse() file=%s key_set=%s transcript_words=%d fallback_pace=%s fallback_filler=%s",
            audio_path,
            bool(self.api_key),
            len(transcript.words),
            fallback.pace_wpm,
            fallback.filler_rate,
        )

        if not self.api_key:
            log.warning("[thymia] no API key, returning transcript fallback only")
            fallback.error = "missing THYMIA_API_KEY, used transcript fallback"
            return fallback

        url = f"{self.api_base}/v1/analyse"
        log.info("[thymia] POST %s", url)
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                with open(audio_path, "rb") as f:
                    files = {"audio": (os.path.basename(audio_path), f, "audio/wav")}
                    headers = {"Authorization": f"Bearer {self.api_key}"}
                    resp = await client.post(url, files=files, headers=headers)
            log.info("[thymia] response status=%d content_type=%s bytes=%d",
                     resp.status_code, resp.headers.get("content-type", ""), len(resp.content))
            if resp.status_code >= 400:
                log.warning("[thymia] error body: %r", resp.text[:400])
                fallback.error = f"thymia {resp.status_code}: {resp.text[:200]}, used transcript fallback"
                return fallback
            payload = resp.json()
            log.info("[thymia] parsed payload keys=%s", list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__)
        except Exception as exc:
            log.exception("[thymia] call failed")
            fallback.error = f"thymia error: {exc}, used transcript fallback"
            return fallback

        merged = _merge_thymia(payload, fallback)
        log.info("[thymia] merged pace=%s filler=%s pitch=%s jitter=%s shimmer=%s",
                 merged.pace_wpm, merged.filler_rate, merged.pitch_mean_hz, merged.jitter, merged.shimmer)
        return merged


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
