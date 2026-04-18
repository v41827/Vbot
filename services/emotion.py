"""Emotion timeline derived from transcript chunks via a local Ollama model.

Swap-in candidates: Hume AI, SER model, thymia emotion endpoint. All must
return the same EmotionResult shape.
"""
from __future__ import annotations

import json
import logging
import os

from ollama import AsyncClient

from .protocols import EmotionPoint, EmotionResult, TranscriptionResult

log = logging.getLogger(__name__)

_CHUNK_SECONDS = 6.0

_PROMPT = """You are labelling short speech fragments for emotional tone.

For each fragment, return a JSON object with key "labels" whose value is an array of objects in the same order as the fragments. Each object has:
- label: one of neutral, calm, happy, excited, anxious, frustrated, sad, uncertain
- valence: number from -1 (very negative) to 1 (very positive)
- arousal: number from 0 (low energy) to 1 (high energy)
- confidence: number from 0 to 1

Return ONLY the JSON object, no prose."""


class OllamaEmotion:
    def __init__(
        self,
        host: str | None = None,
        model: str = "gemma4:e4b",
        max_tokens: int = 800,
    ):
        self.host = host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.model = model
        self.max_tokens = max_tokens
        self._client: AsyncClient | None = None

    def _client_inst(self) -> AsyncClient:
        if self._client is None:
            self._client = AsyncClient(host=self.host)
        return self._client

    async def analyse(
        self,
        audio_path: str,
        transcript: TranscriptionResult,
    ) -> EmotionResult:
        import time as _time
        log.info("[emotion] analyse() words=%d text_preview=%r", len(transcript.words), (transcript.text or "")[:120])
        if not transcript.words:
            log.warning("[emotion] no words in transcript, returning empty timeline")
            return EmotionResult(error="no words in transcript")

        chunks = _chunk_words(transcript.words, _CHUNK_SECONDS)
        log.info("[emotion] built %d chunks from %d words (~%.1fs each)", len(chunks), len(transcript.words), _CHUNK_SECONDS)
        if not chunks:
            return EmotionResult(error="no chunks")

        client = self._client_inst()
        fragments = [f"[{i + 1}] {c['text']}" for i, c in enumerate(chunks)]
        user_msg = "Fragments:\n" + "\n".join(fragments)
        log.info("[emotion] calling ollama model=%s num_predict=%d", self.model, self.max_tokens)

        started = _time.monotonic()
        try:
            resp = await client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": _PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                options={"num_predict": self.max_tokens, "temperature": 0.3},
                format="json",
            )
            raw = _message_content(resp)
            log.info("[emotion] ollama response in %.1fs, raw_len=%d preview=%r",
                     _time.monotonic() - started, len(raw), raw[:200])
            data = _extract_labels(raw)
            log.info("[emotion] parsed %d label entries", len(data))
        except Exception as exc:
            log.exception("[emotion] ollama emotion failed after %.1fs", _time.monotonic() - started)
            return EmotionResult(
                timeline=[
                    EmotionPoint(t=c["t"], label="neutral", valence=0.0, arousal=0.3)
                    for c in chunks
                ],
                dominant="neutral",
                error=str(exc),
            )

        timeline: list[EmotionPoint] = []
        for i, chunk in enumerate(chunks):
            item = data[i] if i < len(data) else {}
            timeline.append(
                EmotionPoint(
                    t=chunk["t"],
                    label=str(item.get("label", "neutral")),
                    valence=_coerce_float(item.get("valence"), 0.0),
                    arousal=_coerce_float(item.get("arousal"), 0.3),
                    confidence=_coerce_float(item.get("confidence"), 0.6),
                )
            )

        dominant = _mode_label(timeline)
        return EmotionResult(timeline=timeline, dominant=dominant)


def _chunk_words(words, chunk_seconds: float):
    chunks = []
    bucket: list[str] = []
    bucket_start = words[0].start if words else 0.0

    for w in words:
        if w.start - bucket_start >= chunk_seconds and bucket:
            chunks.append({"t": bucket_start, "text": " ".join(bucket)})
            bucket = []
            bucket_start = w.start
        bucket.append(w.text)

    if bucket:
        chunks.append({"t": bucket_start, "text": " ".join(bucket)})
    return chunks


def _extract_labels(raw: str) -> list[dict]:
    raw = (raw or "").strip()
    # Ollama with format="json" returns an object; try object first.
    obj_start = raw.find("{")
    obj_end = raw.rfind("}")
    if obj_start != -1 and obj_end != -1:
        try:
            parsed = json.loads(raw[obj_start : obj_end + 1])
            if isinstance(parsed, dict):
                labels = parsed.get("labels")
                if isinstance(labels, list):
                    return labels
                # Some models return the array directly under other keys.
                for v in parsed.values():
                    if isinstance(v, list):
                        return v
            elif isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    # Fall back to top-level array.
    arr_start = raw.find("[")
    arr_end = raw.rfind("]")
    if arr_start != -1 and arr_end != -1:
        try:
            parsed = json.loads(raw[arr_start : arr_end + 1])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return []


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


def _coerce_float(v, default: float) -> float:
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _mode_label(timeline: list[EmotionPoint]) -> str:
    counts: dict[str, int] = {}
    for p in timeline:
        counts[p.label] = counts.get(p.label, 0) + 1
    if not counts:
        return "neutral"
    return max(counts.items(), key=lambda kv: kv[1])[0]
