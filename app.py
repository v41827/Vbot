"""Voice awareness web app.

One FastAPI process handles:
- Live mode: browser mic -> backend -> phone buzz over WebSockets.
- Training mode: record a session, run it through services, show a review page.

All thresholds in config.json. All secrets in .env.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import socket
import time
import uuid
from pathlib import Path
from typing import Any

import aiofiles
import qrcode
import uvicorn
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.cors import CORSMiddleware

from services.coaching_live import OllamaLiveCoaching
from services.live_biomarker import ThymiaLiveBiomarker
from services.live_transcription import SpeechmaticsLiveTranscription
from services.training_processor import process_session

load_dotenv()

ROOT = Path(__file__).parent
CONFIG: dict[str, Any] = json.loads((ROOT / "config.json").read_text())
SESSIONS_DIR = ROOT / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
log = logging.getLogger("app")


# ---------------------------------------------------------------------------
# Live state
# ---------------------------------------------------------------------------


class LiveState:
    def __init__(self):
        self.dashboards: set[WebSocket] = set()
        self.phones: set[WebSocket] = set()
        self.sources: set[WebSocket] = set()

        self.ambient_dbfs: float = float(CONFIG["thresholds"]["default_ambient_dbfs"])
        self.calibrating: bool = False
        self._calibration_samples: list[float] = []
        self._calibration_end_ts: float = 0.0

        self.last_buzz_ts: float = 0.0
        self.last_buzz_kind: str = "safe"
        self.active_state: str = "safe"

        self.recent_dbfs: list[float] = []
        self.latest_transcript: str = ""

    def snapshot(self) -> dict:
        return {
            "ambient_dbfs": round(self.ambient_dbfs, 1),
            "calibrating": self.calibrating,
            "active_state": self.active_state,
            "last_buzz_kind": self.last_buzz_kind,
            "dashboards": len(self.dashboards),
            "phones": len(self.phones),
            "sources": len(self.sources),
        }


state = LiveState()
state_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Voice awareness prototype")
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")
app.mount("/ui", StaticFiles(directory=str(ROOT / "UI")), name="ui")
templates = Jinja2Templates(directory=str(ROOT / "templates"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """Dev convenience: never let the browser cache /static, so edits show up on reload."""
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path.startswith("/ui") or request.url.path in ("/", "/phone", "/train") or request.url.path.startswith("/review"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


def _lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        try:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return ip
    except Exception:
        return "127.0.0.1"


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    lan_ip = _lan_ip()
    port = CONFIG["server"]["port"]
    phone_url = f"http://{lan_ip}:{port}/phone"
    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "phone_url": phone_url,
            "config": CONFIG,
        },
    )


@app.get("/phone", response_class=HTMLResponse)
async def phone(request: Request):
    return templates.TemplateResponse("phone.html", {"request": request, "config": CONFIG})


@app.get("/qr")
async def qr_code():
    lan_ip = _lan_ip()
    port = CONFIG["server"]["port"]
    url = f"http://{lan_ip}:{port}/phone"
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")


@app.get("/config")
async def get_config():
    return CONFIG


@app.get("/state")
async def get_state():
    return state.snapshot()


# ---------------------------------------------------------------------------
# Calibration control (triggered from dashboard button)
# ---------------------------------------------------------------------------


@app.post("/calibrate/start")
async def calibrate_start():
    async with state_lock:
        state.calibrating = True
        state._calibration_samples.clear()
        state._calibration_end_ts = time.monotonic() + CONFIG["audio"]["calibration_seconds"]
    await broadcast_dashboard({"type": "calibration", "status": "started"})
    return {"ok": True}


@app.post("/calibrate/reset")
async def calibrate_reset():
    async with state_lock:
        state.ambient_dbfs = float(CONFIG["thresholds"]["default_ambient_dbfs"])
        state.calibrating = False
        state._calibration_samples.clear()
    await broadcast_dashboard({"type": "calibration", "status": "reset", "ambient_dbfs": state.ambient_dbfs})
    return {"ok": True, "ambient_dbfs": state.ambient_dbfs}


# ---------------------------------------------------------------------------
# WebSockets
# ---------------------------------------------------------------------------


@app.websocket("/ws/source")
async def ws_source(ws: WebSocket):
    """Browser mic -> backend. Expects JSON messages: {type:'volume', dbfs, t}."""
    peer = ws.client.host if ws.client else "unknown"
    await ws.accept()
    state.sources.add(ws)
    log.info("[ws/source] connected peer=%s total=%d", peer, len(state.sources))
    await broadcast_dashboard({"type": "status", **state.snapshot()})
    msg_count = 0
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("[ws/source] bad json: %r", raw[:80])
                continue
            msg_count += 1
            if msg_count <= 3 or msg_count % 200 == 0:
                log.info("[ws/source] msg #%d type=%s sample=%s", msg_count, msg.get("type"), str(msg)[:120])
            await _handle_source_message(msg)
    except WebSocketDisconnect:
        log.info("[ws/source] disconnected peer=%s after %d messages", peer, msg_count)
    except Exception:
        log.exception("[ws/source] error")
    finally:
        state.sources.discard(ws)
        await broadcast_dashboard({"type": "status", **state.snapshot()})


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    peer = ws.client.host if ws.client else "unknown"
    await ws.accept()
    state.dashboards.add(ws)
    log.info("[ws/dashboard] connected peer=%s total=%d", peer, len(state.dashboards))
    await ws.send_json({"type": "hello", **state.snapshot()})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        log.info("[ws/dashboard] disconnected peer=%s", peer)
    except Exception:
        log.exception("[ws/dashboard] error")
    finally:
        state.dashboards.discard(ws)


@app.websocket("/ws/phone")
async def ws_phone(ws: WebSocket):
    peer = ws.client.host if ws.client else "unknown"
    await ws.accept()
    state.phones.add(ws)
    log.info("[ws/phone] connected peer=%s total=%d", peer, len(state.phones))
    await ws.send_json({"type": "hello", "config": CONFIG["buzz"]})
    await broadcast_dashboard({"type": "status", **state.snapshot()})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        log.info("[ws/phone] disconnected peer=%s", peer)
    except Exception:
        log.exception("[ws/phone] error")
    finally:
        state.phones.discard(ws)
        await broadcast_dashboard({"type": "status", **state.snapshot()})


async def _handle_source_message(msg: dict) -> None:
    kind = msg.get("type")
    if kind == "volume":
        dbfs = _safe_float(msg.get("dbfs"))
        if dbfs is None:
            return
        await _on_volume(dbfs)
    elif kind == "transcript":
        text = str(msg.get("text", "")).strip()
        if text:
            state.latest_transcript = (state.latest_transcript + " " + text).strip()[-1500:]
            await broadcast_dashboard({"type": "transcript", "text": state.latest_transcript})
    elif kind == "ping":
        pass


async def _on_volume(dbfs: float) -> None:
    now = time.monotonic()

    if state.calibrating:
        state._calibration_samples.append(dbfs)
        if now >= state._calibration_end_ts:
            async with state_lock:
                if state._calibration_samples:
                    samples_sorted = sorted(state._calibration_samples)
                    trimmed = samples_sorted[
                        int(len(samples_sorted) * 0.1) : int(len(samples_sorted) * 0.9) or None
                    ] or samples_sorted
                    state.ambient_dbfs = sum(trimmed) / len(trimmed)
                state.calibrating = False
                state._calibration_samples.clear()
            await broadcast_dashboard(
                {
                    "type": "calibration",
                    "status": "complete",
                    "ambient_dbfs": round(state.ambient_dbfs, 1),
                }
            )

    state.recent_dbfs.append(dbfs)
    if len(state.recent_dbfs) > 200:
        state.recent_dbfs = state.recent_dbfs[-200:]

    decision = _decide_buzz(dbfs)
    prev_state = state.active_state
    state.active_state = decision
    if decision != prev_state:
        log.info("[decide] state %s -> %s  dbfs=%.1f ambient=%.1f", prev_state, decision, dbfs, state.ambient_dbfs)

    await broadcast_dashboard(
        {
            "type": "meter",
            "dbfs": round(dbfs, 2),
            "ambient_dbfs": round(state.ambient_dbfs, 2),
            "state": decision,
            "calibrating": state.calibrating,
            "thresholds": _current_thresholds(),
        }
    )

    if decision == "safe":
        return

    cooldown_ms = CONFIG["buzz"]["cooldown_ms"]
    if (now - state.last_buzz_ts) * 1000.0 < cooldown_ms:
        return

    state.last_buzz_ts = now
    state.last_buzz_kind = decision
    log.info("[buzz] kind=%s dbfs=%.1f phones=%d", decision, dbfs, len(state.phones))

    buzz_conf = CONFIG["buzz"]
    if decision == "loud":
        payload = {
            "type": "buzz",
            "kind": "loud",
            "vibration_ms": buzz_conf["loud_vibration_ms"],
            "colour": buzz_conf["loud_colour"],
            "hold_ms": buzz_conf["hold_ms"],
        }
    else:
        payload = {
            "type": "buzz",
            "kind": "quiet",
            "vibration_ms": buzz_conf["quiet_vibration_ms"],
            "colour": buzz_conf["quiet_colour"],
            "hold_ms": buzz_conf["hold_ms"],
        }

    await broadcast_phones(payload)
    await broadcast_dashboard({"type": "buzz", **payload})


def _current_thresholds() -> dict:
    t = CONFIG["thresholds"]
    return {
        "ambient": round(state.ambient_dbfs, 1),
        "speaking": round(state.ambient_dbfs + t["speaking_delta_db"], 1),
        "loud": round(state.ambient_dbfs + t["loud_delta_db"], 1),
        "quiet_floor": round(state.ambient_dbfs + t["quiet_delta_db"], 1),
    }


def _decide_buzz(dbfs: float) -> str:
    t = CONFIG["thresholds"]
    speaking = state.ambient_dbfs + t["speaking_delta_db"]
    loud = state.ambient_dbfs + t["loud_delta_db"]
    quiet_floor = state.ambient_dbfs + t["quiet_delta_db"]

    if dbfs >= loud:
        return "loud"
    if dbfs >= speaking and dbfs < quiet_floor:
        return "quiet"
    return "safe"


async def broadcast_dashboard(message: dict) -> None:
    dead: list[WebSocket] = []
    for ws in list(state.dashboards):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for d in dead:
        state.dashboards.discard(d)


async def broadcast_phones(message: dict) -> None:
    dead: list[WebSocket] = []
    for ws in list(state.phones):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for d in dead:
        state.phones.discard(d)


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Training mode
# ---------------------------------------------------------------------------


@app.get("/train", response_class=HTMLResponse)
async def train(request: Request):
    import random
    prompt = random.choice(CONFIG["training"]["prompts"])
    return templates.TemplateResponse(
        "train.html",
        {
            "request": request,
            "prompt": prompt,
            "config": CONFIG,
        },
    )


@app.post("/train/submit")
async def train_submit(
    background: BackgroundTasks,
    video: UploadFile | None = File(None),
    audio: UploadFile = File(...),
    volume: str = Form("[]"),
    transcript_hint: str = Form(""),
    session_id: str = Form(""),
):
    if session_id:
        sid = _safe_id(session_id)
        folder = SESSIONS_DIR / sid
        folder.mkdir(parents=True, exist_ok=True)
        session_id = sid
        log.info("[submit] attaching to existing session %s", session_id)
    else:
        session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        folder = SESSIONS_DIR / session_id
        folder.mkdir(parents=True, exist_ok=True)
        log.info("[submit] generated new session_id %s", session_id)
    log.info(
        "[submit] new session %s audio=%s(%s) video=%s(%s)",
        session_id,
        audio.filename,
        audio.content_type,
        video.filename if video else None,
        video.content_type if video else None,
    )

    audio_ext = _pick_ext(audio.filename, audio.content_type, default="webm")
    audio_path = folder / f"audio.{audio_ext}"
    audio_bytes = await audio.read()
    async with aiofiles.open(audio_path, "wb") as f:
        await f.write(audio_bytes)
    log.info("[submit] wrote %s (%d bytes)", audio_path, len(audio_bytes))

    if video is not None and video.filename:
        video_ext = _pick_ext(video.filename, video.content_type, default="webm")
        video_path = folder / f"video.{video_ext}"
        video_bytes = await video.read()
        async with aiofiles.open(video_path, "wb") as f:
            await f.write(video_bytes)
        log.info("[submit] wrote %s (%d bytes)", video_path, len(video_bytes))

    try:
        volume_timeline = json.loads(volume) if volume else []
    except json.JSONDecodeError:
        log.warning("[submit] could not parse volume JSON, defaulting to empty")
        volume_timeline = []
    (folder / "volume.json").write_text(json.dumps(volume_timeline))
    log.info("[submit] volume_timeline points=%d", len(volume_timeline))

    if transcript_hint:
        (folder / "transcript_hint.txt").write_text(transcript_hint)
        log.info("[submit] transcript_hint len=%d", len(transcript_hint))

    (folder / "status.json").write_text(json.dumps({"status": "processing"}))
    background.add_task(_process_session_bg, session_id)

    return {"session_id": session_id, "status": "processing"}


async def _process_session_bg(session_id: str) -> None:
    folder = SESSIONS_DIR / session_id
    log.info("[bg] start processing session %s", session_id)
    try:
        # Hard cap so a hung Ollama / Thymia call can't leave the UI stuck forever.
        await asyncio.wait_for(process_session(str(folder), CONFIG), timeout=150)
        (folder / "status.json").write_text(json.dumps({"status": "ready"}))
        log.info("[bg] session %s marked READY", session_id)
    except asyncio.TimeoutError:
        log.error("[bg] session %s TIMED OUT after 150s", session_id)
        (folder / "status.json").write_text(
            json.dumps({"status": "failed", "error": "processing timed out after 150s — check Ollama / Speechmatics / Thymia are running"})
        )
    except Exception as exc:
        log.exception("[bg] session %s FAILED: %s", session_id, exc)
        (folder / "status.json").write_text(
            json.dumps({"status": "failed", "error": f"{type(exc).__name__}: {exc}"})
        )


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    folder = SESSIONS_DIR / _safe_id(session_id)
    if not folder.exists():
        raise HTTPException(status_code=404, detail="session not found")
    report_path = folder / "report.json"
    status_path = folder / "status.json"
    status = {"status": "unknown"}
    if status_path.exists():
        try:
            status = json.loads(status_path.read_text())
        except json.JSONDecodeError:
            pass
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text())
        except json.JSONDecodeError:
            return JSONResponse({"status": status, "error": "bad report json"}, status_code=500)
        return {"status": status, "report": report}
    return {"status": status}


@app.get("/session/{session_id}/media/{filename}")
async def session_media(session_id: str, filename: str):
    folder = SESSIONS_DIR / _safe_id(session_id)
    safe_name = filename.replace("..", "").replace("/", "")
    path = folder / safe_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="media not found")
    return FileResponse(path)


@app.get("/review/{session_id}", response_class=HTMLResponse)
async def review(request: Request, session_id: str):
    sid = _safe_id(session_id)
    folder = SESSIONS_DIR / sid
    if not folder.exists():
        raise HTTPException(status_code=404, detail="session not found")
    return templates.TemplateResponse(
        "review.html",
        {
            "request": request,
            "session_id": sid,
            "config": CONFIG,
        },
    )


# ---------------------------------------------------------------------------
# Live coaching during training (rolling tips)
# ---------------------------------------------------------------------------

live_coach = OllamaLiveCoaching(
    host=os.getenv("OLLAMA_HOST", "http://localhost:11434"),
    model=CONFIG["coaching"]["live_model"],
    max_tokens=CONFIG["coaching"]["max_tokens_live"],
    max_tip_chars=CONFIG["coaching_live"]["max_tip_chars"],
)


@app.websocket("/ws/train")
async def ws_train(ws: WebSocket):
    """One coaching websocket per training session.

    Receives rolling transcript + volume. Sends back tips periodically.
    """
    await ws.accept()
    tick = float(CONFIG["coaching_live"]["tick_seconds"])
    last_tip_ts = 0.0
    rolling_transcript = ""
    recent_volume: list[float] = []

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "transcript":
                text = str(msg.get("text", "")).strip()
                if text:
                    rolling_transcript = (rolling_transcript + " " + text).strip()[-2000:]

            if msg.get("type") == "volume":
                v = _safe_float(msg.get("dbfs"))
                if v is not None:
                    recent_volume.append(v)
                    if len(recent_volume) > 120:
                        recent_volume = recent_volume[-120:]

            now = time.monotonic()
            if (now - last_tip_ts) < tick:
                continue
            last_tip_ts = now

            tip = await live_coach.next_tip(
                rolling_transcript=rolling_transcript,
                recent_volume=recent_volume,
                ambient_dbfs=state.ambient_dbfs,
            )
            if tip is None:
                continue

            await ws.send_json({"type": "tip", "text": tip.text, "category": tip.category})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("train ws error")


# ---------------------------------------------------------------------------
# Live streaming for training (Speechmatics RT + Thymia Sentinel)
# ---------------------------------------------------------------------------


@app.websocket("/ws/train/stream")
async def ws_train_stream(ws: WebSocket):
    """Per-session live audio pipeline.

    Handshake:
        client connects
        server creates session folder, sends {"type":"ready","session_id":...}
        client sends binary PCM frames (s16le 16 kHz mono)
        server streams back {"type":"partial","text":...},
                            {"type":"final","text":...,"words":[...]},
                            {"type":"policy","result":{...}}
        on close, server persists live_transcript.json and thymia_sentinel.json
    """
    peer = ws.client.host if ws.client else "unknown"
    log.info("[ws/train/stream] incoming connection peer=%s", peer)
    try:
        await ws.accept()
    except Exception:
        log.exception("[ws/train/stream] accept() failed")
        return
    log.info("[ws/train/stream] accepted peer=%s", peer)

    session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    folder = SESSIONS_DIR / session_id
    folder.mkdir(parents=True, exist_ok=True)
    log.info("[ws/train/stream] peer=%s session=%s", peer, session_id)

    live_cfg = CONFIG.get("live_stream", {})
    sm_cfg = CONFIG.get("speechmatics", {})
    sentinel_cfg = CONFIG.get("thymia_sentinel", {})

    live_tx = SpeechmaticsLiveTranscription(
        language=sm_cfg.get("language", "en"),
        sample_rate=live_cfg.get("target_sample_rate", 16000),
        chunk_samples=live_cfg.get("chunk_samples", 2048),
        max_delay=sm_cfg.get("max_delay", 0.7),
        enable_partials=sm_cfg.get("enable_partials", True),
    )
    sentinel: ThymiaLiveBiomarker | None = None
    if sentinel_cfg.get("enabled", True):
        sentinel = ThymiaLiveBiomarker(
            user_label=sentinel_cfg.get("user_label", "training-user"),
            policies=sentinel_cfg.get("policies", ["demo_wellbeing_awareness"]),
        )

    async def send_partial(text: str) -> None:
        try:
            await ws.send_json({"type": "partial", "text": text})
        except Exception:
            pass

    async def send_final(text: str, words: list) -> None:
        try:
            await ws.send_json({
                "type": "final",
                "text": text,
                "words": [w.__dict__ for w in words],
            })
        except Exception:
            pass
        if sentinel is not None and text:
            await sentinel.send_transcript(text)

    async def send_policy(result: dict) -> None:
        try:
            await ws.send_json({"type": "policy", "result": result})
        except Exception:
            pass

    live_tx.on_partial(send_partial)
    live_tx.on_final(send_final)
    if sentinel is not None:
        sentinel.on_policy(send_policy)

    await live_tx.start()
    if sentinel is not None:
        await sentinel.start()

    await ws.send_json({
        "type": "ready",
        "session_id": session_id,
        "transcription_enabled": live_tx.error is None,
        "biomarker_enabled": sentinel is not None and sentinel.error is None,
        "transcription_error": live_tx.error,
        "biomarker_error": (sentinel.error if sentinel else "disabled"),
    })

    frames_in = 0
    bytes_in = 0
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            text = msg.get("text")
            if data is not None:
                frames_in += 1
                bytes_in += len(data)
                await live_tx.send_pcm(data)
                if sentinel is not None:
                    await sentinel.send_audio(data)
                if frames_in <= 3 or frames_in % 100 == 0:
                    log.info(
                        "[ws/train/stream] frame=%d total_bytes=%d partial=%r",
                        frames_in, bytes_in, live_tx.partial_text[:60],
                    )
            elif text is not None:
                try:
                    ctrl = json.loads(text)
                except json.JSONDecodeError:
                    continue
                ctype = ctrl.get("type")
                if ctype == "stop":
                    log.info("[ws/train/stream] client requested stop")
                    break
                elif ctype == "ping":
                    await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        log.info("[ws/train/stream] client disconnected")
    except Exception:
        log.exception("[ws/train/stream] error")
    finally:
        log.info(
            "[ws/train/stream] closing session=%s frames=%d bytes=%d",
            session_id, frames_in, bytes_in,
        )
        try:
            await live_tx.close()
        except Exception:
            log.exception("live_tx close failed")
        if sentinel is not None:
            try:
                await sentinel.close()
            except Exception:
                log.exception("sentinel close failed")

        transcript = live_tx.finalise()
        live_transcript_path = folder / "live_transcript.json"
        live_transcript_path.write_text(json.dumps(transcript.to_dict(), indent=2))
        log.info(
            "[ws/train/stream] saved %s words=%d text_len=%d error=%s",
            live_transcript_path, len(transcript.words), len(transcript.text), transcript.error,
        )
        if sentinel is not None:
            sentinel_path = folder / "thymia_sentinel.json"
            sentinel_path.write_text(json.dumps(sentinel.summary(), indent=2, default=str))
            log.info("[ws/train/stream] saved %s", sentinel_path)

        try:
            await ws.send_json({
                "type": "done",
                "session_id": session_id,
                "words": len(transcript.words),
                "text": transcript.text,
                "error": transcript.error,
            })
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _safe_id(session_id: str) -> str:
    return "".join(c for c in session_id if c.isalnum() or c in ("-", "_"))


def _pick_ext(filename: str | None, content_type: str | None, default: str = "webm") -> str:
    if filename and "." in filename:
        return filename.rsplit(".", 1)[-1].lower()
    if content_type:
        if "webm" in content_type:
            return "webm"
        if "mp4" in content_type:
            return "mp4"
        if "wav" in content_type:
            return "wav"
        if "ogg" in content_type:
            return "ogg"
    return default


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    host = CONFIG["server"]["host"]
    port = CONFIG["server"]["port"]
    lan = _lan_ip()
    banner = [
        "",
        "================================================================",
        "  Voice awareness prototype",
        "",
        f"  Dashboard (this machine):  http://localhost:{port}/",
        f"  Dashboard (LAN):           http://{lan}:{port}/",
        f"  Phone page (same wifi):    http://{lan}:{port}/phone",
        "",
        "  IMPORTANT: open the dashboard from http://localhost so the",
        "  browser lets you use the microphone. LAN URL is fine for the",
        "  phone page but blocked for the mic on the laptop.",
        "================================================================",
        "",
    ]
    for line in banner:
        log.info(line)
    uvicorn.run("app:app", host=host, port=port, reload=False, log_level="info")
