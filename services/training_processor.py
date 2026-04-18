"""Runs a recorded session folder through every service and writes report.json."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import wave
from pathlib import Path

from .biomarker import ThymiaBiomarker
from .coaching import OllamaCoaching
from .emotion import OllamaEmotion
from .protocols import (
    BiomarkerResult,
    CoachingReport,
    EmotionResult,
    TranscriptionResult,
)
from .transcription import SpeechmaticsTranscription

log = logging.getLogger(__name__)


async def process_session(session_dir: str, config: dict) -> dict:
    import time as _time
    overall_start = _time.monotonic()
    folder = Path(session_dir)
    log.info("==================== PROCESS SESSION START %s ====================", folder.name)
    if not folder.exists():
        raise FileNotFoundError(f"Session folder not found: {session_dir}")

    audio_path = _find_audio(folder)
    if audio_path is None:
        raise FileNotFoundError(f"No audio.wav or audio.webm in {folder}")
    log.info("[process] audio file: %s (size=%d bytes)", audio_path, audio_path.stat().st_size)
    speechmatics_audio = _ensure_speechmatics_audio(audio_path)
    if speechmatics_audio != audio_path:
        log.info(
            "[process] converted audio for speechmatics: %s -> %s",
            audio_path.name,
            speechmatics_audio.name,
        )

    video_file = _find_video(folder)
    log.info("[process] video file: %s", video_file)

    volume_path = folder / "volume.json"
    volume_timeline = _load_volume(volume_path)
    log.info("[process] volume timeline points=%d", len(volume_timeline))

    transcript_hint_path = folder / "transcript_hint.txt"
    if transcript_hint_path.exists():
        hint = transcript_hint_path.read_text()
        log.info("[process] transcript_hint.txt present (len=%d): %r", len(hint), hint[:200])

    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    model = config["coaching"].get("model", "gemma4:e4b")
    log.info("[process] ollama host=%s model=%s", host, model)

    transcription = SpeechmaticsTranscription(
        language=config["speechmatics"].get("language", "en"),
        operating_point=config["speechmatics"].get("operating_point", "standard"),
    )
    emotion_svc = OllamaEmotion(
        host=host,
        model=model,
        video_config=config.get("video_emotion", {}),
    )
    biomarker_svc = ThymiaBiomarker()
    coach = OllamaCoaching(
        host=host,
        model=model,
        max_tokens=config["coaching"].get("max_tokens_report", 1200),
    )

    log.info("[process] -------- STAGE 1: Speechmatics transcription --------")
    stage_start = _time.monotonic()
    transcript: TranscriptionResult = await transcription.transcribe(str(speechmatics_audio))
    log.info(
        "[process] transcription done in %.1fs text_len=%d words=%d error=%s",
        _time.monotonic() - stage_start,
        len(transcript.text or ""),
        len(transcript.words),
        transcript.error,
    )

    if not transcript.duration_seconds and volume_timeline:
        last_t = volume_timeline[-1].get("t", 0.0)
        if last_t:
            transcript.duration_seconds = float(last_t)
            log.info("[process] backfilled duration from volume timeline: %.2fs", transcript.duration_seconds)

    log.info("[process] -------- STAGE 2: Emotion (Ollama) + Biomarker (thymia) in parallel --------")
    stage_start = _time.monotonic()
    emotion, biomarker = await asyncio.gather(
        emotion_svc.analyse(
            str(audio_path),
            transcript,
            video_path=str(folder / video_file) if video_file else None,
        ),
        biomarker_svc.analyse(str(audio_path), transcript),
    )
    log.info(
        "[process] stage 2 done in %.1fs; emotion timeline=%d dominant=%s error=%s; biomarker pace=%s filler=%s error=%s",
        _time.monotonic() - stage_start,
        len(emotion.timeline),
        emotion.dominant,
        emotion.error,
        biomarker.pace_wpm,
        biomarker.filler_rate,
        biomarker.error,
    )

    log.info("[process] -------- STAGE 3: Coaching report (Ollama) --------")
    stage_start = _time.monotonic()
    report: CoachingReport = await coach.generate_report(
        transcript=transcript,
        emotion=emotion,
        biomarker=biomarker,
        volume_timeline=volume_timeline,
    )
    log.info(
        "[process] coaching done in %.1fs score=%s tips=%d error=%s",
        _time.monotonic() - stage_start,
        report.score,
        len(report.tips),
        report.error,
    )

    out = {
        "session_id": folder.name,
        "audio_file": audio_path.name,
        "video_file": _find_video(folder),
        "duration_seconds": transcript.duration_seconds,
        "transcript": transcript.to_dict(),
        "emotion": emotion.to_dict(),
        "biomarker": biomarker.to_dict(),
        "volume_timeline": volume_timeline,
        "report": report.to_dict(),
    }

    report_path = folder / "report.json"
    report_path.write_text(json.dumps(out, indent=2))
    log.info(
        "==================== PROCESS SESSION DONE %s in %.1fs, wrote %s ====================",
        folder.name,
        _time.monotonic() - overall_start,
        report_path,
    )
    return out


def _find_audio(folder: Path) -> Path | None:
    for name in ("audio.wav", "audio.webm", "audio.mp3", "audio.m4a"):
        p = folder / name
        if p.exists():
            return p
    return None


def _find_video(folder: Path) -> str | None:
    for name in ("video.webm", "video.mp4", "video.mov"):
        p = folder / name
        if p.exists():
            return name
    return None


def _ensure_speechmatics_audio(audio_path: Path) -> Path:
    """Convert unsupported training uploads (e.g. webm) into wav for batch STT."""
    suffix = audio_path.suffix.lower()
    supported = {".wav", ".mp3", ".aac", ".ogg", ".mpeg", ".amr", ".m4a", ".mp4", ".flac"}
    if suffix in supported:
        return audio_path

    if suffix != ".webm":
        log.warning("[process] unsupported audio extension for Speechmatics: %s", suffix or "<none>")
        return audio_path

    wav_path = audio_path.with_name("audio.wav")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(audio_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    try:
        log.info("[process] converting webm -> wav with ffmpeg")
        completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
        if completed.stderr:
            log.info("[process] ffmpeg: %s", completed.stderr.strip()[:500])
        return wav_path if wav_path.exists() else audio_path
    except FileNotFoundError:
        log.error("[process] ffmpeg not found; cannot convert webm for Speechmatics")
        return audio_path
    except subprocess.CalledProcessError as exc:
        log.error(
            "[process] ffmpeg conversion failed exit=%s stderr=%s",
            exc.returncode,
            (exc.stderr or "")[:500],
        )
        return audio_path


def _load_volume(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("timeline"), list):
        return data["timeline"]
    return []
