"""Speechmatics-backed batch transcription for training sessions.

Uses the HTTP batch API. The SDK polls the job until done. We log aggressively
so a silent failure can be diagnosed from the terminal.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from .protocols import TranscriptionResult, TranscriptWord

log = logging.getLogger(__name__)


class SpeechmaticsTranscription:
    def __init__(
        self,
        api_key: str | None = None,
        language: str = "en",
        operating_point: str = "standard",
    ):
        self.api_key = api_key or os.getenv("SPEECHMATICS_API_KEY", "")
        self.language = language
        op = (operating_point or "standard").strip().lower()
        self.operating_point = op if op in {"standard", "enhanced"} else "standard"

    async def transcribe(self, audio_path: str) -> TranscriptionResult:
        path = Path(audio_path)
        log.info("[speechmatics] transcribe() called path=%s", path)

        if not path.exists():
            log.error("[speechmatics] file does not exist: %s", path)
            return TranscriptionResult(text="", error=f"Audio file not found: {audio_path}")

        size = path.stat().st_size
        head = _read_head(path, 16)
        sniff = _sniff_container(head)
        log.info(
            "[speechmatics] file check size=%d bytes head=%s sniff=%s",
            size,
            head.hex(),
            sniff,
        )
        if size == 0:
            log.error("[speechmatics] file is empty")
            return TranscriptionResult(text="", error="audio file is empty (0 bytes)")

        if not self.api_key:
            log.warning("[speechmatics] SPEECHMATICS_API_KEY missing")
            return TranscriptionResult(text="", error="missing SPEECHMATICS_API_KEY")

        log.info(
            "[speechmatics] using key ending %s (len=%d) language=%s",
            self.api_key[-4:],
            len(self.api_key),
            self.language,
        )

        try:
            from speechmatics.batch_client import BatchClient  # noqa: F401
            from speechmatics.models import BatchTranscriptionConfig, ConnectionSettings
        except ImportError as exc:
            log.error("[speechmatics] speechmatics-python not installed: %s", exc)
            return TranscriptionResult(text="", error=str(exc))

        settings = ConnectionSettings(
            url="https://asr.api.speechmatics.com/v2",
            auth_token=self.api_key,
        )
        # Keep config minimal: enhanced requires a capable account and some plans
        # reject it. If you see a 4xx response switch to operating_point="standard".
        config = BatchTranscriptionConfig(
            language=self.language,
            operating_point=self.operating_point,
        )
        log.info("[speechmatics] submitting batch job url=%s op=%s", settings.url, self.operating_point)

        started = time.monotonic()
        try:
            import asyncio
            result = await asyncio.to_thread(self._run_batch, path, settings, config)
        except Exception as exc:
            if self.operating_point == "enhanced" and _looks_like_config_rejection(exc):
                log.warning("[speechmatics] enhanced rejected; retrying with standard operating point")
                fallback_config = BatchTranscriptionConfig(
                    language=self.language,
                    operating_point="standard",
                )
                try:
                    import asyncio
                    result = await asyncio.to_thread(self._run_batch, path, settings, fallback_config)
                except Exception:
                    pass
                else:
                    elapsed = time.monotonic() - started
                    log.info("[speechmatics] fallback completed in %.1fs", elapsed)
                    return result
            elapsed = time.monotonic() - started
            log.exception("[speechmatics] batch failed after %.1fs", elapsed)
            return TranscriptionResult(text="", error=f"{type(exc).__name__}: {exc}")

        elapsed = time.monotonic() - started
        log.info(
            "[speechmatics] completed in %.1fs words=%d duration=%.2fs text_preview=%r",
            elapsed,
            len(result.words),
            result.duration_seconds,
            result.text[:120],
        )
        if not result.words:
            log.warning("[speechmatics] transcript is empty. possible causes: silent audio, unsupported format, auth rejected on job, or job returned without 'word' entries")
        return result

    def _run_batch(self, path: Path, settings, config) -> TranscriptionResult:
        from speechmatics.batch_client import BatchClient
        from speechmatics.exceptions import JobNotFoundException, TranscriptionError

        log.info("[speechmatics] opening BatchClient")
        try:
            with BatchClient(settings) as client:
                log.info("[speechmatics] submitting job file=%s", path)
                try:
                    job_id = client.submit_job(audio=str(path), transcription_config=config)
                except Exception as exc:
                    log.exception("[speechmatics] submit_job raised %s", type(exc).__name__)
                    raise
                log.info("[speechmatics] job submitted id=%s, polling for completion...", job_id)

                try:
                    transcript_json = client.wait_for_completion(job_id, transcription_format="json-v2")
                except (JobNotFoundException, TranscriptionError) as exc:
                    log.exception("[speechmatics] job %s failed: %s", job_id, exc)
                    raise
                except Exception as exc:
                    log.exception("[speechmatics] wait_for_completion raised %s", type(exc).__name__)
                    raise

                log.info("[speechmatics] job %s completed, parsing payload", job_id)
        except Exception:
            raise

        _debug_dump(transcript_json, path)
        parsed = _parse_speechmatics_json(transcript_json)
        return parsed


def _debug_dump(payload, src_path: Path) -> None:
    """Dump the raw Speechmatics payload alongside the audio so we can inspect."""
    try:
        dump_path = src_path.parent / "speechmatics_raw.json"
        with open(dump_path, "w") as f:
            if isinstance(payload, (dict, list)):
                json.dump(payload, f, indent=2)
            else:
                f.write(str(payload))
        log.info("[speechmatics] raw payload saved to %s", dump_path)
    except Exception:
        log.exception("[speechmatics] could not write raw payload dump")


def _read_head(path: Path, n: int) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _sniff_container(head: bytes) -> str:
    """Return a rough guess at the container format based on magic bytes."""
    if not head:
        return "empty"
    if head[:4] == b"\x1A\x45\xDF\xA3":
        return "webm/matroska (EBML)"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:3] == b"ID3" or head[:2] == b"\xFF\xFB":
        return "mp3"
    if head[4:8] == b"ftyp":
        return f"mp4/m4a (brand={head[8:12].decode('ascii', errors='replace')})"
    if head[:4] == b"OggS":
        return "ogg"
    return "unknown magic " + head[:8].hex()


def _parse_speechmatics_json(payload: dict) -> TranscriptionResult:
    if not isinstance(payload, dict):
        log.warning("[speechmatics] payload is not a dict, type=%s", type(payload).__name__)
        return TranscriptionResult(text="", error="non-dict payload")

    meta = payload.get("metadata") or {}
    job = payload.get("job") or {}
    log.info(
        "[speechmatics] payload metadata transcription_config=%s job=%s",
        json.dumps(meta.get("transcription_config", {}), default=str)[:200],
        json.dumps({k: job.get(k) for k in ("id", "status", "duration")}, default=str)[:200],
    )

    results = payload.get("results", [])
    log.info("[speechmatics] results array length=%d", len(results))

    words: list[TranscriptWord] = []
    text_parts: list[str] = []
    non_word_types: dict[str, int] = {}

    for r in results:
        t = r.get("type")
        if t != "word":
            non_word_types[t] = non_word_types.get(t, 0) + 1
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

    if non_word_types:
        log.info("[speechmatics] non-word entries: %s", non_word_types)

    duration = words[-1].end if words else 0.0
    text = " ".join(text_parts)
    log.info("[speechmatics] parsed words=%d duration=%.2fs", len(words), duration)
    return TranscriptionResult(text=text, words=words, duration_seconds=duration)


def _looks_like_config_rejection(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code in (400, 403):
        return True
    text = str(exc).lower()
    return "400" in text or "403" in text or "entitlement" in text
