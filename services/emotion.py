"""Audio+video emotion timeline with Ollama and EmotiEffLib fusion."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
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

_EMOTI_TO_APP = {
    "Anger": "frustrated",
    "Contempt": "frustrated",
    "Disgust": "frustrated",
    "Fear": "anxious",
    "Happiness": "happy",
    "Neutral": "neutral",
    "Sadness": "sad",
    "Surprise": "excited",
}

_LABEL_TO_VA = {
    "neutral": (0.0, 0.35),
    "calm": (0.2, 0.2),
    "happy": (0.75, 0.7),
    "excited": (0.55, 0.9),
    "anxious": (-0.45, 0.85),
    "frustrated": (-0.65, 0.75),
    "sad": (-0.75, 0.25),
    "uncertain": (-0.1, 0.45),
}


@dataclass
class VideoEmotionPoint:
    t: float
    label: str
    valence: float
    arousal: float
    confidence: float


class OllamaEmotion:
    def __init__(
        self,
        host: str | None = None,
        model: str = "gemma4:e4b",
        max_tokens: int = 800,
        video_config: dict | None = None,
    ):
        self.host = host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.model = model
        self.max_tokens = max_tokens
        self._client: AsyncClient | None = None

        cfg = video_config or {}
        self.video_enabled = bool(cfg.get("enabled", True))
        self.video_engine = str(cfg.get("engine", "onnx"))
        self.video_model_name = str(cfg.get("model_name", "enet_b0_8_best_vgaf"))
        self.video_device = str(cfg.get("device", "cpu"))
        self.video_fps_sample = float(cfg.get("fps_sample", 2.0))
        self.video_face_conf_min = float(cfg.get("face_conf_min", 0.35))
        self.fusion_window_seconds = float(cfg.get("fusion_window_seconds", 1.0))
        self.fusion_audio_weight = float(cfg.get("audio_weight", 0.6))
        self.fusion_video_weight = float(cfg.get("video_weight", 0.4))
        self._video_recognizer = None

    def _client_inst(self) -> AsyncClient:
        if self._client is None:
            self._client = AsyncClient(host=self.host)
        return self._client

    async def analyse(
        self,
        audio_path: str,
        transcript: TranscriptionResult,
        video_path: str | None = None,
    ) -> EmotionResult:
        import asyncio
        import time as _time

        log.info(
            "[emotion] analyse() words=%d text_preview=%r video=%s",
            len(transcript.words),
            (transcript.text or "")[:120],
            video_path,
        )

        video_points: list[VideoEmotionPoint] = []
        video_error: str | None = None
        if self.video_enabled and video_path:
            try:
                video_points = await asyncio.to_thread(self._analyse_video_sync, video_path)
                log.info("[emotion] video points=%d", len(video_points))
            except Exception as exc:
                video_error = f"video emotion failed: {type(exc).__name__}: {exc}"
                log.exception("[emotion] %s", video_error)

        audio_timeline: list[EmotionPoint] = []
        audio_error: str | None = None
        if transcript.words:
            chunks = _chunk_words(transcript.words, _CHUNK_SECONDS)
            log.info(
                "[emotion] built %d chunks from %d words (~%.1fs each)",
                len(chunks),
                len(transcript.words),
                _CHUNK_SECONDS,
            )
            if chunks:
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
                    log.info(
                        "[emotion] ollama response in %.1fs, raw_len=%d preview=%r",
                        _time.monotonic() - started,
                        len(raw),
                        raw[:200],
                    )
                    data = _extract_labels(raw)
                    log.info("[emotion] parsed %d label entries", len(data))
                except Exception as exc:
                    audio_error = f"audio emotion failed: {type(exc).__name__}: {exc}"
                    log.exception("[emotion] %s", audio_error)
                    data = []

                for i, chunk in enumerate(chunks):
                    item = data[i] if i < len(data) else {}
                    audio_timeline.append(
                        EmotionPoint(
                            t=chunk["t"],
                            label=_normalize_app_label(str(item.get("label", "neutral"))),
                            valence=_coerce_float(item.get("valence"), 0.0),
                            arousal=_coerce_float(item.get("arousal"), 0.3),
                            confidence=_coerce_float(item.get("confidence"), 0.6),
                        )
                    )

        if audio_timeline and video_points:
            timeline = _fuse_timelines(
                audio_timeline=audio_timeline,
                video_points=video_points,
                window_seconds=self.fusion_window_seconds,
                w_audio=self.fusion_audio_weight,
                w_video=self.fusion_video_weight,
            )
        elif audio_timeline:
            timeline = audio_timeline
        elif video_points:
            timeline = [
                EmotionPoint(
                    t=v.t,
                    label=v.label,
                    valence=v.valence,
                    arousal=v.arousal,
                    confidence=v.confidence,
                )
                for v in video_points
            ]
        else:
            log.warning("[emotion] no usable audio/video emotion signal")
            return EmotionResult(error="no words in transcript and no usable video emotion")

        error_parts = [x for x in (audio_error, video_error) if x]
        return EmotionResult(
            timeline=timeline,
            dominant=_mode_label(timeline),
            error="; ".join(error_parts) if error_parts else None,
        )

    def _analyse_video_sync(self, video_path: str) -> list[VideoEmotionPoint]:
        import cv2
        from emotiefflib.facial_analysis import EmotiEffLibRecognizer

        path = Path(video_path)
        if not path.exists():
            raise FileNotFoundError(f"video not found: {video_path}")

        if self._video_recognizer is None:
            log.info(
                "[emotion] loading EmotiEffLib recognizer engine=%s model=%s device=%s",
                self.video_engine,
                self.video_model_name,
                self.video_device,
            )
            self._video_recognizer = EmotiEffLibRecognizer(
                engine=self.video_engine,
                model_name=self.video_model_name,
                device=self.video_device,
            )

        cap = cv2.VideoCapture(str(path))
        if not cap.isOpened():
            raise RuntimeError(f"cannot open video: {video_path}")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        step = max(1, int((fps / self.video_fps_sample) if fps > 0 else 15))

        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        points: list[VideoEmotionPoint] = []
        frame_idx = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if frame_idx % step != 0:
                    frame_idx += 1
                    continue

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
                if len(faces) == 0:
                    frame_idx += 1
                    continue

                # Pick largest face for single-speaker training flow.
                x, y, w, h = max(faces, key=lambda rect: rect[2] * rect[3])
                face_img = rgb[y : y + h, x : x + w]
                labels, scores = self._video_recognizer.predict_emotions(face_img, logits=False)
                if not labels:
                    frame_idx += 1
                    continue

                label = _emoti_to_app_label(labels[0])
                # Scores shape for one image: (1, n_classes) in current API.
                conf = float(np.max(scores[0])) if getattr(scores, "ndim", 0) >= 2 else 0.0
                if conf < self.video_face_conf_min:
                    frame_idx += 1
                    continue

                valence, arousal = _label_to_va(label)
                t = (frame_idx / fps) if fps > 0 else float(frame_idx) / 30.0
                points.append(
                    VideoEmotionPoint(
                        t=t,
                        label=label,
                        valence=valence,
                        arousal=arousal,
                        confidence=conf,
                    )
                )
                frame_idx += 1
        finally:
            cap.release()

        return points


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


def _fuse_timelines(
    audio_timeline: list[EmotionPoint],
    video_points: list[VideoEmotionPoint],
    window_seconds: float,
    w_audio: float,
    w_video: float,
) -> list[EmotionPoint]:
    if not audio_timeline:
        return []
    if not video_points:
        return audio_timeline

    total = max(1e-6, w_audio + w_video)
    wa = max(0.0, w_audio) / total
    wv = max(0.0, w_video) / total

    out: list[EmotionPoint] = []
    for a in audio_timeline:
        candidates = [v for v in video_points if abs(v.t - a.t) <= window_seconds]
        if not candidates:
            out.append(a)
            continue

        v_conf_sum = sum(max(1e-6, v.confidence) for v in candidates)
        v_val = sum(v.valence * max(1e-6, v.confidence) for v in candidates) / v_conf_sum
        v_aro = sum(v.arousal * max(1e-6, v.confidence) for v in candidates) / v_conf_sum
        v_conf = min(1.0, v_conf_sum / len(candidates))

        fused_val = wa * a.valence + wv * v_val
        fused_aro = wa * a.arousal + wv * v_aro
        fused_conf = min(1.0, wa * a.confidence + wv * v_conf)
        fused_label = _closest_label(fused_val, fused_aro)
        out.append(
            EmotionPoint(
                t=a.t,
                label=fused_label,
                valence=fused_val,
                arousal=fused_aro,
                confidence=fused_conf,
            )
        )
    return out


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


def _normalize_app_label(label: str) -> str:
    label_l = (label or "").strip().lower()
    return label_l if label_l in _LABEL_TO_VA else "neutral"


def _emoti_to_app_label(label: str) -> str:
    mapped = _EMOTI_TO_APP.get((label or "").strip(), "uncertain")
    return _normalize_app_label(mapped)


def _label_to_va(label: str) -> tuple[float, float]:
    return _LABEL_TO_VA.get(label, _LABEL_TO_VA["neutral"])


def _closest_label(valence: float, arousal: float) -> str:
    best_label = "neutral"
    best_dist = float("inf")
    for label, (v, a) in _LABEL_TO_VA.items():
        dist = (valence - v) ** 2 + (arousal - a) ** 2
        if dist < best_dist:
            best_dist = dist
            best_label = label
    return best_label


def _mode_label(timeline: list[EmotionPoint]) -> str:
    counts: dict[str, int] = {}
    for p in timeline:
        counts[p.label] = counts.get(p.label, 0) + 1
    if not counts:
        return "neutral"
    return max(counts.items(), key=lambda kv: kv[1])[0]
