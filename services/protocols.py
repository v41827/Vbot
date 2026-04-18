"""Protocol interfaces all services conform to.

Any service swap must preserve these field names, types, and shapes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Any


@dataclass
class TranscriptWord:
    start: float
    end: float
    text: str
    confidence: float = 1.0


@dataclass
class TranscriptionResult:
    text: str
    words: list[TranscriptWord] = field(default_factory=list)
    language: str = "en"
    duration_seconds: float = 0.0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "words": [w.__dict__ for w in self.words],
            "language": self.language,
            "duration_seconds": self.duration_seconds,
            "error": self.error,
        }


@dataclass
class EmotionPoint:
    t: float
    label: str
    valence: float
    arousal: float
    confidence: float = 1.0


@dataclass
class EmotionResult:
    timeline: list[EmotionPoint] = field(default_factory=list)
    dominant: str = "neutral"
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "timeline": [p.__dict__ for p in self.timeline],
            "dominant": self.dominant,
            "error": self.error,
        }


@dataclass
class BiomarkerResult:
    pace_wpm: float | None = None
    filler_rate: float | None = None
    pitch_mean_hz: float | None = None
    pitch_variability: float | None = None
    jitter: float | None = None
    shimmer: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "pace_wpm": self.pace_wpm,
            "filler_rate": self.filler_rate,
            "pitch_mean_hz": self.pitch_mean_hz,
            "pitch_variability": self.pitch_variability,
            "jitter": self.jitter,
            "shimmer": self.shimmer,
            "extra": self.extra,
            "error": self.error,
        }


@dataclass
class CoachingTip:
    category: str
    text: str


@dataclass
class CoachingReport:
    summary: str
    tips: list[CoachingTip] = field(default_factory=list)
    score: int = 0
    strengths: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "tips": [t.__dict__ for t in self.tips],
            "score": self.score,
            "strengths": self.strengths,
            "error": self.error,
        }


@dataclass
class LiveCoachingTip:
    t: float
    text: str
    category: str = "general"


class TranscriptionService(Protocol):
    async def transcribe(self, audio_path: str) -> TranscriptionResult: ...


class EmotionService(Protocol):
    async def analyse(
        self,
        audio_path: str,
        transcript: TranscriptionResult,
    ) -> EmotionResult: ...


class BiomarkerService(Protocol):
    async def analyse(
        self,
        audio_path: str,
        transcript: TranscriptionResult,
    ) -> BiomarkerResult: ...


class CoachingService(Protocol):
    async def generate_report(
        self,
        transcript: TranscriptionResult,
        emotion: EmotionResult,
        biomarker: BiomarkerResult,
        volume_timeline: list[dict[str, float]],
    ) -> CoachingReport: ...


class LiveCoachingService(Protocol):
    async def next_tip(
        self,
        rolling_transcript: str,
        recent_volume: list[float],
        ambient_dbfs: float,
    ) -> LiveCoachingTip | None: ...
