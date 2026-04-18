"""Speechmatics-backed batch transcription for training sessions."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from .protocols import TranscriptionResult, TranscriptWord

log = logging.getLogger(__name__)


class SpeechmaticsTranscription:
    def __init__(self, api_key: str | None = None, language: str = "en"):
        self.api_key = api_key or os.getenv("SPEECHMATICS_API_KEY", "")
        self.language = language

    async def transcribe(self, audio_path: str) -> TranscriptionResult:
        path = Path(audio_path)
        if not path.exists():
            return TranscriptionResult(text="", error=f"Audio file not found: {audio_path}")

        if not self.api_key:
            log.warning("SPEECHMATICS_API_KEY missing, returning empty transcript")
            return TranscriptionResult(text="", error="missing SPEECHMATICS_API_KEY")

        try:
            from speechmatics.batch_client import BatchClient
            from speechmatics.models import BatchTranscriptionConfig, ConnectionSettings
        except ImportError as exc:
            log.error("speechmatics-python not installed: %s", exc)
            return TranscriptionResult(text="", error=str(exc))

        settings = ConnectionSettings(
            url="https://asr.api.speechmatics.com/v2",
            auth_token=self.api_key,
        )
        config = BatchTranscriptionConfig(
            language=self.language,
            operating_point="enhanced",
            enable_entities=True,
        )

        try:
            import asyncio
            return await asyncio.to_thread(self._run_batch, path, settings, config)
        except Exception as exc:
            log.exception("speechmatics batch failed")
            return TranscriptionResult(text="", error=str(exc))

    def _run_batch(self, path: Path, settings, config) -> TranscriptionResult:
        from speechmatics.batch_client import BatchClient

        with BatchClient(settings) as client:
            job_id = client.submit_job(audio=str(path), transcription_config=config)
            transcript = client.wait_for_completion(job_id, transcription_format="json-v2")

        return _parse_speechmatics_json(transcript)


def _parse_speechmatics_json(payload: dict) -> TranscriptionResult:
    results = payload.get("results", []) if isinstance(payload, dict) else []
    words: list[TranscriptWord] = []
    text_parts: list[str] = []

    for r in results:
        if r.get("type") != "word":
            continue
        alts = r.get("alternatives") or []
        if not alts:
            continue
        top = alts[0]
        w = TranscriptWord(
            start=float(r.get("start_time", 0.0)),
            end=float(r.get("end_time", 0.0)),
            text=top.get("content", ""),
            confidence=float(top.get("confidence", 1.0)),
        )
        words.append(w)
        text_parts.append(w.text)

    duration = words[-1].end if words else 0.0
    text = " ".join(text_parts)
    return TranscriptionResult(text=text, words=words, duration_seconds=duration)
