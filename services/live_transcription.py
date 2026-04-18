"""Speechmatics Realtime (streaming) transcription.

Wraps `speechmatics-rt` AsyncClient so the app can push PCM audio chunks in and
receive partial + final transcript events out via callbacks. Also accumulates
word-level entries so the session ends with the same TranscriptionResult shape
as batch transcription.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable

from .protocols import TranscriptionResult, TranscriptWord

log = logging.getLogger(__name__)

PartialCb = Callable[[str], Awaitable[None] | None]
FinalCb = Callable[[str, list[TranscriptWord]], Awaitable[None] | None]


class SpeechmaticsLiveTranscription:
    """One instance per streaming session."""

    def __init__(
        self,
        api_key: str | None = None,
        language: str = "en",
        sample_rate: int = 16000,
        chunk_samples: int = 2048,
        max_delay: float = 0.7,
        enable_partials: bool = True,
    ):
        self.api_key = api_key or os.getenv("SPEECHMATICS_API_KEY", "")
        self.language = language
        self.sample_rate = sample_rate
        self.chunk_samples = chunk_samples
        self.max_delay = max_delay
        self.enable_partials = enable_partials

        self._client = None
        self._session_task: asyncio.Task | None = None
        self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._ready = asyncio.Event()
        self._closed = asyncio.Event()

        self._on_partial: PartialCb | None = None
        self._on_final: FinalCb | None = None

        self.all_words: list[TranscriptWord] = []
        self.final_text_parts: list[str] = []
        self.partial_text: str = ""
        self.started_at: float = 0.0
        self.error: str | None = None

    def on_partial(self, cb: PartialCb) -> None:
        self._on_partial = cb

    def on_final(self, cb: FinalCb) -> None:
        self._on_final = cb

    async def start(self) -> None:
        if not self.api_key:
            self.error = "missing SPEECHMATICS_API_KEY"
            log.error("[sm-rt] %s", self.error)
            self._ready.set()  # unblock send_audio to drop chunks
            return

        try:
            from speechmatics.rt import (  # type: ignore
                AsyncClient,
                AudioEncoding,
                AudioFormat,
                ServerMessageType,
                TranscriptionConfig,
                TranscriptResult,
            )
        except Exception as exc:
            self.error = f"speechmatics-rt import failed: {exc}"
            log.exception("[sm-rt] %s", self.error)
            self._ready.set()
            return

        self._sm = {
            "AsyncClient": AsyncClient,
            "AudioEncoding": AudioEncoding,
            "AudioFormat": AudioFormat,
            "ServerMessageType": ServerMessageType,
            "TranscriptionConfig": TranscriptionConfig,
            "TranscriptResult": TranscriptResult,
        }
        log.info("[sm-rt] starting session rate=%d max_delay=%.2f partials=%s",
                 self.sample_rate, self.max_delay, self.enable_partials)
        self._session_task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        sm = self._sm
        try:
            audio_format = sm["AudioFormat"](
                encoding=sm["AudioEncoding"].PCM_S16LE,
                sample_rate=self.sample_rate,
                chunk_size=self.chunk_samples * 2,  # bytes
            )
            transcription_config = sm["TranscriptionConfig"](
                language=self.language,
                max_delay=self.max_delay,
                enable_partials=self.enable_partials,
            )

            async with sm["AsyncClient"](api_key=self.api_key) as client:
                self._client = client

                loop = asyncio.get_running_loop()

                @client.on(sm["ServerMessageType"].ADD_PARTIAL_TRANSCRIPT)
                def _on_partial_msg(msg: Any) -> None:
                    try:
                        result = sm["TranscriptResult"].from_message(msg)
                        text = getattr(getattr(result, "metadata", None), "transcript", "") or ""
                        self.partial_text = text
                        if text and self._on_partial:
                            self._schedule(loop, self._on_partial(text))
                    except Exception:
                        log.exception("[sm-rt] partial handler error")

                @client.on(sm["ServerMessageType"].ADD_TRANSCRIPT)
                def _on_final_msg(msg: Any) -> None:
                    try:
                        result = sm["TranscriptResult"].from_message(msg)
                        text = getattr(getattr(result, "metadata", None), "transcript", "") or ""
                        words = _extract_words(msg)
                        if words:
                            self.all_words.extend(words)
                        if text:
                            self.final_text_parts.append(text)
                            self.partial_text = ""
                        if text and self._on_final:
                            self._schedule(loop, self._on_final(text, words))
                    except Exception:
                        log.exception("[sm-rt] final handler error")

                log.info("[sm-rt] start_session")
                self.started_at = time.monotonic()
                await client.start_session(
                    transcription_config=transcription_config,
                    audio_format=audio_format,
                )
                self._ready.set()

                while not self._closed.is_set():
                    try:
                        chunk = await asyncio.wait_for(self._audio_queue.get(), timeout=0.2)
                    except asyncio.TimeoutError:
                        continue
                    if chunk is None:  # sentinel
                        break
                    try:
                        await client.send_audio(chunk)
                    except Exception as exc:
                        log.warning("[sm-rt] send_audio failed: %s", exc)
                        self.error = f"send_audio failed: {exc}"
                        break

                # Drain queue
                log.info("[sm-rt] ending session, draining queue")
                try:
                    await client.end_session()
                except Exception:
                    log.exception("[sm-rt] end_session failed")
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
            log.exception("[sm-rt] session crashed")
            self._ready.set()

    def _schedule(self, loop: asyncio.AbstractEventLoop, maybe_coro: Any) -> None:
        if asyncio.iscoroutine(maybe_coro):
            asyncio.run_coroutine_threadsafe(maybe_coro, loop)

    async def send_pcm(self, chunk: bytes) -> None:
        if self.error:
            return
        if not self._ready.is_set():
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                log.warning("[sm-rt] not ready within 5s, dropping chunk")
                return
        if self.error:
            return
        await self._audio_queue.put(chunk)

    async def close(self) -> None:
        log.info("[sm-rt] close() called, words so far=%d", len(self.all_words))
        self._closed.set()
        await self._audio_queue.put(b"")  # nudge
        if self._session_task is not None:
            try:
                await asyncio.wait_for(self._session_task, timeout=10.0)
            except asyncio.TimeoutError:
                log.warning("[sm-rt] session task did not finish in 10s, cancelling")
                self._session_task.cancel()
            except Exception:
                log.exception("[sm-rt] session task raised on close")

    def finalise(self) -> TranscriptionResult:
        text = " ".join(p for p in self.final_text_parts if p)
        if not text and self.all_words:
            text = " ".join(w.text for w in self.all_words)
        duration = self.all_words[-1].end if self.all_words else 0.0
        return TranscriptionResult(
            text=text.strip(),
            words=self.all_words,
            duration_seconds=duration,
            error=self.error,
        )


def _extract_words(msg: Any) -> list[TranscriptWord]:
    """Parse word-level entries from a Speechmatics RT message.

    The message shape mirrors the batch JSON-v2 format, so each entry of type
    'word' carries alternatives with content + confidence, plus start_time and
    end_time. We defensively handle slightly different shapes between SDK
    versions.
    """
    results = None
    if isinstance(msg, dict):
        results = msg.get("results")
    else:
        results = getattr(msg, "results", None) or getattr(msg, "Results", None)
    if not results:
        return []
    out: list[TranscriptWord] = []
    for r in results:
        t = r.get("type") if isinstance(r, dict) else getattr(r, "type", None)
        if t != "word":
            continue
        alts = r.get("alternatives") if isinstance(r, dict) else getattr(r, "alternatives", None)
        if not alts:
            continue
        top = alts[0]
        if isinstance(top, dict):
            content = top.get("content", "")
            conf = float(top.get("confidence", 1.0) or 1.0)
        else:
            content = getattr(top, "content", "") or ""
            conf = float(getattr(top, "confidence", 1.0) or 1.0)
        start = float((r.get("start_time") if isinstance(r, dict) else getattr(r, "start_time", 0.0)) or 0.0)
        end = float((r.get("end_time") if isinstance(r, dict) else getattr(r, "end_time", 0.0)) or 0.0)
        out.append(TranscriptWord(start=start, end=end, text=content, confidence=conf))
    return out
