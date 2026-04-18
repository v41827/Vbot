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
    TranscriptWord,
)
from .transcription import SpeechmaticsTranscription

log = logging.getLogger(__name__)


def _write_stage(folder: Path, stage: str) -> None:
    """Update status.json with the current processing stage so the review UI
    can show 'Transcribing…' / 'Reading biomarkers…' / 'Drafting tips…' etc.
    We keep status='processing' until the final ready/failed write."""
    try:
        (folder / "status.json").write_text(json.dumps({"status": "processing", "stage": stage}))
    except OSError:
        pass


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
    )
    emotion_svc = OllamaEmotion(host=host, model=model)
    biomarker_svc = ThymiaBiomarker()
    coach = OllamaCoaching(
        host=host,
        model=model,
        max_tokens=config["coaching"].get("max_tokens_report", 1200),
    )

    log.info("[process] -------- STAGE 1: Transcription --------")
    _write_stage(folder, "transcribing")
    stage_start = _time.monotonic()
    live_transcript = _load_live_transcript(folder)
    if live_transcript is not None and (live_transcript.words or live_transcript.text):
        log.info(
            "[process] using LIVE transcript (Speechmatics RT) words=%d text_len=%d",
            len(live_transcript.words),
            len(live_transcript.text or ""),
        )
        transcript = live_transcript
    else:
        log.info("[process] no live transcript, falling back to Speechmatics batch")
        try:
            transcript = await asyncio.wait_for(transcription.transcribe(str(audio_path)), timeout=60)
        except asyncio.TimeoutError:
            log.warning("[process] Speechmatics batch timed out, using empty transcript")
            from .protocols import TranscriptionResult
            transcript = TranscriptionResult(error="speechmatics batch timed out")
    log.info(
        "[process] transcription done in %.1fs text_len=%d words=%d error=%s",
        _time.monotonic() - stage_start,
        len(transcript.text or ""),
        len(transcript.words),
        transcript.error,
    )

    thymia_live = _load_thymia_live(folder)
    if thymia_live is not None:
        log.info(
            "[process] found live thymia Sentinel summary: %d policy results, error=%s",
            len(thymia_live.get("policy_results", []) or []),
            thymia_live.get("error"),
        )

    if not transcript.duration_seconds and volume_timeline:
        last_t = volume_timeline[-1].get("t", 0.0)
        if last_t:
            transcript.duration_seconds = float(last_t)
            log.info("[process] backfilled duration from volume timeline: %.2fs", transcript.duration_seconds)

    log.info("[process] -------- STAGE 2: Emotion (Ollama) + Biomarker (thymia) in parallel --------")
    _write_stage(folder, "reading_signals")
    stage_start = _time.monotonic()
    # Each sub-service has its own soft timeout; wrap them so a hung model
    # doesn't block the whole session forever.
    async def _emotion_safe():
        try:
            return await asyncio.wait_for(emotion_svc.analyse(str(audio_path), transcript), timeout=50)
        except asyncio.TimeoutError:
            from .protocols import EmotionResult
            log.warning("[process] emotion analysis timed out")
            return EmotionResult(error="emotion timed out")
    async def _biomarker_safe():
        try:
            return await asyncio.wait_for(biomarker_svc.analyse(str(audio_path), transcript), timeout=35)
        except asyncio.TimeoutError:
            from .protocols import BiomarkerResult
            log.warning("[process] biomarker analysis timed out")
            return BiomarkerResult(error="biomarker timed out")
    emotion, biomarker = await asyncio.gather(_emotion_safe(), _biomarker_safe())
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
    _write_stage(folder, "drafting_tips")
    stage_start = _time.monotonic()
    scenario_context = _load_scenario_context(folder)
    try:
        report: CoachingReport = await asyncio.wait_for(
            coach.generate_report(
                transcript=transcript,
                emotion=emotion,
                biomarker=biomarker,
                volume_timeline=volume_timeline,
                scenario=scenario_context,
                thymia_live=thymia_live,
            ),
            timeout=60,
        )
    except asyncio.TimeoutError:
        log.warning("[process] coaching timed out, using fallback tips")
        report = _fallback_report(transcript, emotion, biomarker)
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
        "live_thymia": thymia_live,
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


def _load_live_transcript(folder: Path) -> TranscriptionResult | None:
    """Read live_transcript.json written by /ws/train/stream, return TranscriptionResult."""
    path = folder / "live_transcript.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    words = [
        TranscriptWord(
            start=float(w.get("start", 0.0)),
            end=float(w.get("end", 0.0)),
            text=str(w.get("text", "")),
            confidence=float(w.get("confidence", 1.0)),
        )
        for w in (data.get("words") or [])
        if isinstance(w, dict)
    ]
    return TranscriptionResult(
        text=str(data.get("text", "") or ""),
        words=words,
        language=str(data.get("language", "en")),
        duration_seconds=float(data.get("duration_seconds") or 0.0),
        error=data.get("error"),
    )


def _load_thymia_live(folder: Path) -> dict | None:
    path = folder / "thymia_sentinel.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


_SCENARIO_PROMPTS = {
    "standup": {
        "label": "Daily standup",
        "prompt": "What did you ship yesterday, what are you picking up today, any blockers?",
        "audience": "your team, in two minutes or less",
    },
    "interview": {
        "label": "Tech interview",
        "prompt": "Walk me through a project you're proud of and what made it work.",
        "audience": "a senior interviewer, giving you exactly five minutes",
    },
    "pitch": {
        "label": "Investor pitch",
        "prompt": "You have two minutes. What's the problem, who do you solve it for, and why now?",
        "audience": "a sceptical investor",
    },
}


def _load_scenario_context(folder: Path) -> dict | None:
    """Read scenario.json (written by /train/submit) and return the prompt dict."""
    path = folder / "scenario.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    scenario_id = str(data.get("scenario") or "").strip().lower()
    ctx = dict(_SCENARIO_PROMPTS.get(scenario_id) or {})
    ctx["scenario_id"] = scenario_id
    if data.get("prompt"):
        ctx["prompt"] = data["prompt"]
    return ctx or None


def _fallback_report(transcript, emotion, biomarker):
    """Deterministic mini-report we use when Ollama coaching times out, so the
    user always lands on a complete review page."""
    from .protocols import CoachingReport, CoachingTip

    tips: list[CoachingTip] = []
    pace = getattr(biomarker, "pace_wpm", None) or 0
    filler_rate = getattr(biomarker, "filler_rate", None) or 0

    if pace and pace > 190:
        tips.append(CoachingTip(category="pace", text="You were speaking quickly. Try one breath per sentence next time."))
    elif pace and pace < 120 and pace > 0:
        tips.append(CoachingTip(category="pace", text="Lift the pace a little. The energy tends to drop when speech gets too slow."))
    if filler_rate and filler_rate > 0.03:
        tips.append(CoachingTip(category="clarity", text="Replace fillers (um, uh) with short pauses. It reads as more confident."))
    if getattr(emotion, "dominant", None) in ("anxious", "uncertain"):
        tips.append(CoachingTip(category="emotion", text="Breathe before each new sentence. It relaxes the tone."))
    while len(tips) < 3:
        tips.append(CoachingTip(category="general", text="Record another run and compare your pace and pauses."))
    tips = tips[:3]

    summary_bits = []
    if pace:
        summary_bits.append(f"Pace around {int(pace)} wpm")
    if getattr(emotion, "dominant", None):
        summary_bits.append(f"{emotion.dominant} tone")
    summary = " · ".join(summary_bits) or "Session recorded."

    return CoachingReport(
        summary=summary,
        score=int(max(30, min(90, 72 - (filler_rate or 0) * 300))),
        strengths=["You finished the take"],
        tips=tips,
        error="coaching timed out, fallback used",
    )
