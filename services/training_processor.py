"""Runs a recorded session folder through every service and writes report.json."""
from __future__ import annotations

import asyncio
import json
import logging
import os
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
    folder = Path(session_dir)
    if not folder.exists():
        raise FileNotFoundError(f"Session folder not found: {session_dir}")

    audio_path = _find_audio(folder)
    if audio_path is None:
        raise FileNotFoundError(f"No audio.wav or audio.webm in {folder}")

    volume_path = folder / "volume.json"
    volume_timeline = _load_volume(volume_path)

    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    model = config["coaching"].get("model", "gemma4:e4b")

    transcription = SpeechmaticsTranscription(
        language=config["speechmatics"].get("language", "en"),
    )
    emotion_svc = OllamaEmotion(host=host, model=model)
    biomarker_svc = ThymiaBiomarker()
    coach = OllamaCoaching(
        host=host,
        model=model,
        max_tokens=config["coaching"].get("max_tokens_report", 1200),
    )

    log.info("transcribing %s", audio_path)
    transcript: TranscriptionResult = await transcription.transcribe(str(audio_path))

    if not transcript.duration_seconds and volume_timeline:
        last_t = volume_timeline[-1].get("t", 0.0)
        if last_t:
            transcript.duration_seconds = float(last_t)

    log.info("emotion + biomarkers in parallel")
    emotion, biomarker = await asyncio.gather(
        emotion_svc.analyse(str(audio_path), transcript),
        biomarker_svc.analyse(str(audio_path), transcript),
    )

    log.info("coaching report")
    report: CoachingReport = await coach.generate_report(
        transcript=transcript,
        emotion=emotion,
        biomarker=biomarker,
        volume_timeline=volume_timeline,
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
    log.info("wrote %s", report_path)
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
