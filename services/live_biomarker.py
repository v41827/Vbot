"""Thymia Sentinel live biomarker streaming.

Wraps `thymia-sentinel` SentinelClient so the app can stream user audio +
transcripts in and receive policy results (biomarker-backed actions) out via a
callback. Degrades gracefully: if the key is missing, the package is not
installed, or the call fails, the whole session continues without biomarkers.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

PolicyCb = Callable[[dict], Awaitable[None] | None]


class ThymiaLiveBiomarker:
    def __init__(
        self,
        api_key: str | None = None,
        user_label: str = "training-user",
        policies: list[str] | None = None,
    ):
        self.api_key = api_key or os.getenv("THYMIA_API_KEY", "")
        self.user_label = user_label
        self.policies = policies or ["demo_wellbeing_awareness"]

        self._client = None
        self._connected = asyncio.Event()
        self._closed = False
        self._on_policy: PolicyCb | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        self.policy_results: list[dict] = []
        self.error: str | None = None

    def on_policy(self, cb: PolicyCb) -> None:
        self._on_policy = cb

    async def start(self) -> None:
        if not self.api_key:
            self.error = "missing THYMIA_API_KEY"
            log.warning("[thymia-rt] %s, live biomarkers disabled", self.error)
            return

        try:
            from thymia_sentinel import SentinelClient  # type: ignore
        except Exception as exc:
            self.error = f"thymia-sentinel import failed: {exc}"
            log.exception("[thymia-rt] %s", self.error)
            return

        # The SDK reads THYMIA_API_KEY from env. Pass explicitly if constructor supports it.
        try:
            try:
                self._client = SentinelClient(
                    user_label=self.user_label,
                    policies=self.policies,
                    api_key=self.api_key,
                )
            except TypeError:
                os.environ["THYMIA_API_KEY"] = self.api_key
                self._client = SentinelClient(
                    user_label=self.user_label,
                    policies=self.policies,
                )
        except Exception as exc:
            self.error = f"SentinelClient init failed: {exc}"
            log.exception("[thymia-rt] %s", self.error)
            self._client = None
            return

        self._loop = asyncio.get_running_loop()

        try:
            decorator = getattr(self._client, "on_policy_result", None)
            if callable(decorator):
                @decorator
                async def _cb(result: dict) -> None:  # noqa: F811
                    self.policy_results.append({
                        "t": time.monotonic(),
                        "result": result,
                    })
                    log.info("[thymia-rt] policy result received keys=%s", list(result.keys()) if isinstance(result, dict) else type(result).__name__)
                    if self._on_policy:
                        maybe = self._on_policy(result)
                        if asyncio.iscoroutine(maybe):
                            await maybe
        except Exception:
            log.exception("[thymia-rt] failed to register on_policy_result")

        try:
            log.info("[thymia-rt] connecting user=%s policies=%s", self.user_label, self.policies)
            await self._client.connect()
            self._connected.set()
            log.info("[thymia-rt] connected")
        except Exception as exc:
            self.error = f"connect failed: {exc}"
            log.exception("[thymia-rt] %s", self.error)

    async def send_audio(self, chunk: bytes) -> None:
        if self._client is None or self.error:
            return
        if not self._connected.is_set():
            return
        try:
            await self._client.send_user_audio(chunk)
        except Exception as exc:
            log.warning("[thymia-rt] send_user_audio failed: %s", exc)
            self.error = f"send_user_audio failed: {exc}"

    async def send_transcript(self, text: str) -> None:
        if self._client is None or self.error:
            return
        if not self._connected.is_set():
            return
        try:
            await self._client.send_user_transcript(text)
        except Exception as exc:
            log.warning("[thymia-rt] send_user_transcript failed: %s", exc)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._client is None:
            return
        try:
            await self._client.close()
            log.info("[thymia-rt] closed; %d policy results captured", len(self.policy_results))
        except Exception:
            log.exception("[thymia-rt] close failed")

    def summary(self) -> dict:
        return {
            "policy_results": self.policy_results,
            "error": self.error,
        }
