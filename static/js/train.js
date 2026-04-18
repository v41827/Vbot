console.log("[train] train.js loaded", new Date().toISOString());

// Always-visible on-page debug panel so we do not need DevTools.
const __trainDebug = (() => {
  const panel = document.createElement("div");
  panel.id = "train-debug";
  panel.style.cssText = [
    "position:fixed","top:0","left:0","right:0","z-index:9999",
    "background:#111","color:#8e8e93","border-bottom:1px solid #222",
    "font:12px ui-monospace,SF Mono,Menlo,monospace",
    "padding:6px 10px","max-height:140px","overflow-y:auto","white-space:pre-wrap",
  ].join(";");
  const inject = () => { if (!document.body.contains(panel)) document.body.appendChild(panel); };
  if (document.body) inject();
  else document.addEventListener("DOMContentLoaded", inject);
  const write = (line) => {
    inject();
    const t = new Date().toLocaleTimeString("en-GB", { hour12: false }) + "." +
      String(Math.floor(performance.now() % 1000)).padStart(3, "0");
    panel.textContent = `[${t}] ${line}\n` + panel.textContent;
    if (panel.textContent.length > 8000) panel.textContent = panel.textContent.slice(0, 8000);
  };
  write("train.js loaded " + new Date().toISOString());
  return { write };
})();
const dbg = (msg, ...rest) => { console.log("[train]", msg, ...rest); __trainDebug.write(msg + (rest.length ? " " + rest.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join(" ") : "")); };
const dbgErr = (msg, ...rest) => { console.error("[train]", msg, ...rest); __trainDebug.write("ERROR: " + msg + (rest.length ? " " + rest.map((r) => { try { return typeof r === "string" ? r : JSON.stringify(r); } catch { return String(r); } }).join(" ") : "")); };

window.addEventListener("error", (e) => dbgErr("uncaught", e.message, "@", e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => dbgErr("unhandled promise", (e.reason && (e.reason.message || e.reason.name)) || String(e.reason)));

(() => {
  const preview = document.getElementById("preview");
  const tipEl = document.getElementById("tip");
  const timer = document.getElementById("timer");
  const miniBar = document.getElementById("mini-bar");
  const status = document.getElementById("train-status");
  const promptEl = document.getElementById("prompt-text");

  const btnRecord = document.getElementById("btn-record");
  const btnStop = document.getElementById("btn-stop");
  const btnNewPrompt = document.getElementById("btn-new-prompt");
  const camDeviceSel = document.getElementById("cam-device");
  const micDeviceSel = document.getElementById("mic-device");

  dbg("element check:",
    "preview=" + !!preview,
    "btn-record=" + !!btnRecord,
    "btn-stop=" + !!btnStop,
    "cam-device=" + !!camDeviceSel,
    "mic-device=" + !!micDeviceSel,
    "train-status=" + !!status);

  if (!btnRecord) {
    dbgErr("btn-record element missing — HTML is stale. Force reload with Cmd+Shift+R.");
    return;
  }

  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerId = null;
  let meterRaf = null;
  let trainWs = null;
  let recognition = null;
  let rollingTranscriptHint = "";
  let volumeTimeline = [];

  const MIN_DB = -80;
  const MAX_DB = 0;

  function pct(db) {
    const c = Math.max(MIN_DB, Math.min(MAX_DB, db));
    return ((c - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
  }

  function checkSecureContext() {
    const host = location.hostname;
    const isSecure = window.isSecureContext ||
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isSecure) {
      const msg = `Camera + mic blocked: browsers require HTTPS or localhost. You are on ${location.origin}. Open http://localhost:8000/train on this machine.`;
      console.error("[train] " + msg);
      if (status) status.textContent = msg;
      return false;
    }
    return true;
  }

  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const mics = devices.filter((d) => d.kind === "audioinput");

      if (camDeviceSel) {
        const prev = camDeviceSel.value;
        camDeviceSel.innerHTML = "";
        const d = document.createElement("option");
        d.value = ""; d.textContent = "System default";
        camDeviceSel.appendChild(d);
        cams.forEach((c, i) => {
          const o = document.createElement("option");
          o.value = c.deviceId;
          o.textContent = c.label || `Camera ${i + 1}`;
          camDeviceSel.appendChild(o);
        });
        const saved = localStorage.getItem("voice-cam-device");
        if (saved && cams.some((c) => c.deviceId === saved)) camDeviceSel.value = saved;
        else if (prev && cams.some((c) => c.deviceId === prev)) camDeviceSel.value = prev;
      }

      if (micDeviceSel) {
        const prev = micDeviceSel.value;
        micDeviceSel.innerHTML = "";
        const d = document.createElement("option");
        d.value = ""; d.textContent = "System default";
        micDeviceSel.appendChild(d);
        mics.forEach((m, i) => {
          const o = document.createElement("option");
          o.value = m.deviceId;
          o.textContent = m.label || `Microphone ${i + 1}`;
          micDeviceSel.appendChild(o);
        });
        const saved = localStorage.getItem("voice-mic-device");
        if (saved && mics.some((m) => m.deviceId === saved)) micDeviceSel.value = saved;
        else if (prev && mics.some((m) => m.deviceId === prev)) micDeviceSel.value = prev;
      }

      console.log("[train] cams:", cams.map((c) => c.label || c.deviceId));
      console.log("[train] mics:", mics.map((m) => m.label || m.deviceId));
    } catch (err) {
      console.warn("[train] enumerateDevices failed", err);
    }
  }

  async function ensureStream(forceNew = false) {
    dbg("ensureStream enter; have stream=" + !!stream + " forceNew=" + forceNew);
    if (stream && !forceNew) { dbg("reusing existing stream"); return stream; }
    if (stream && forceNew) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (!checkSecureContext()) throw new Error("insecure context");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("mediaDevices.getUserMedia is not available in this browser/context");
    }

    const camId = camDeviceSel ? camDeviceSel.value : "";
    const micId = micDeviceSel ? micDeviceSel.value : "";
    const constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    };
    if (camId) constraints.video.deviceId = { exact: camId };
    if (micId) constraints.audio.deviceId = { exact: micId };

    dbg("requesting getUserMedia camId=" + (camId || "default") + " micId=" + (micId || "default"));

    const timeoutMs = 10000;
    const timedOut = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`getUserMedia timed out after ${timeoutMs}ms — browser may be awaiting camera permission or the device is busy`)), timeoutMs)
    );

    try {
      stream = await Promise.race([navigator.mediaDevices.getUserMedia(constraints), timedOut]);
    } catch (err) {
      dbgErr("getUserMedia failed: " + (err.name || "") + " " + (err.message || String(err)));
      if (status) status.textContent = "Camera or mic blocked: " + (err.message || err.name);
      throw err;
    }
    dbg("stream acquired video=[" + stream.getVideoTracks().map((t) => t.label).join(",") + "] audio=[" + stream.getAudioTracks().map((t) => t.label).join(",") + "]");

    preview.srcObject = stream;
    preview.muted = true;
    preview.playsInline = true;
    try {
      await preview.play();
      dbg("preview playing " + preview.videoWidth + "x" + preview.videoHeight);
    } catch (err) {
      dbgErr("preview.play() failed: " + (err.message || err.name));
      if (status) status.textContent = "Click anywhere to start preview, then try again.";
    }
    await populateDevices();
    return stream;
  }

  function setupAnalyser(s) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(s);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let lastSend = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length) || 1e-9;
      const dbfs = 20 * Math.log10(rms);
      miniBar.style.width = pct(dbfs) + "%";

      const now = performance.now();
      const elapsed = (now - startedAt) / 1000;
      if (elapsed > 0) {
        volumeTimeline.push({ t: +elapsed.toFixed(3), dbfs: +dbfs.toFixed(2) });
      }

      if (trainWs && trainWs.readyState === WebSocket.OPEN && now - lastSend > 250) {
        trainWs.send(JSON.stringify({ type: "volume", dbfs, t: elapsed }));
        lastSend = now;
      }
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function connectTrainWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    trainWs = new WebSocket(`${proto}://${location.host}/ws/train`);
    trainWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "tip" && msg.text) showTip(msg.text);
      } catch {}
    };
  }

  function showTip(text) {
    tipEl.classList.add("hidden");
    setTimeout(() => {
      tipEl.textContent = text;
      tipEl.classList.remove("hidden");
    }, 300);
  }

  function startRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-GB";
    recognition.onresult = (evt) => {
      let finalText = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const r = evt.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
      }
      if (!finalText.trim()) return;
      rollingTranscriptHint += finalText;
      if (trainWs && trainWs.readyState === WebSocket.OPEN) {
        trainWs.send(JSON.stringify({ type: "transcript", text: finalText.trim() }));
      }
    };
    recognition.onerror = () => {};
    recognition.onend = () => { if (recorder && recorder.state === "recording") recognition.start(); };
    try { recognition.start(); } catch {}
  }

  function pickRecorderMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  function showError(msg) {
    dbgErr(msg);
    if (status) {
      status.textContent = msg;
      status.style.color = "#ff453a";
      status.style.fontWeight = "500";
    }
  }

  async function startRecording() {
    dbg("startRecording called");
    let s;
    try {
      s = await ensureStream();
    } catch (err) {
      showError("Cannot start: " + (err.message || err.name || String(err)));
      return;
    }
    if (!s) {
      showError("No media stream available.");
      return;
    }
    tipEl.textContent = "Listening…";
    btnRecord.disabled = true;
    btnStop.disabled = false;
    status.textContent = "";
    status.style.color = "";
    chunks = [];
    volumeTimeline = [];
    rollingTranscriptHint = "";

    try {
      connectTrainWs();
      setupAnalyser(s);
      startRecognition();

      const mime = pickRecorderMime();
      console.log("[train] using MIME:", mime || "(browser default)");
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = handleStop;
      recorder.onerror = (e) => console.error("[train] recorder error", e);
      recorder.start(250);
      console.log("[train] recorder started, state=", recorder.state);
    } catch (err) {
      showError("Recorder failed: " + (err.message || err.name || String(err)));
      btnRecord.disabled = false;
      btnStop.disabled = true;
      return;
    }

    startedAt = performance.now();
    timerId = setInterval(() => {
      const secs = Math.floor((performance.now() - startedAt) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, "0");
      const s2 = String(secs % 60).padStart(2, "0");
      timer.textContent = `${m}:${s2}`;
      if (secs >= window.TRAINING_MAX) stopRecording();
    }, 250);
  }

  function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    btnStop.disabled = true;
    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch {}
    }
    if (meterRaf) cancelAnimationFrame(meterRaf);
    clearInterval(timerId);
    if (audioCtx) audioCtx.close();
    if (trainWs) trainWs.close();
  }

  async function handleStop() {
    const elapsedSecs = (performance.now() - startedAt) / 1000;
    if (elapsedSecs < window.TRAINING_MIN) {
      status.textContent = `Too short. Record for at least ${window.TRAINING_MIN} seconds.`;
      btnRecord.disabled = false;
      tipEl.textContent = "Press record when you are ready.";
      return;
    }

    status.textContent = "Uploading…";
    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });

    const form = new FormData();
    form.append("video", blob, "video.webm");
    form.append("audio", blob, "audio.webm");
    form.append("volume", JSON.stringify(volumeTimeline));
    form.append("transcript_hint", rollingTranscriptHint.trim());

    try {
      const resp = await fetch("/train/submit", { method: "POST", body: form });
      const data = await resp.json();
      status.textContent = "Analysing…";
      location.href = `/review/${data.session_id}`;
    } catch (err) {
      status.textContent = "Upload failed: " + err;
      btnRecord.disabled = false;
    }
  }

  btnRecord.addEventListener("click", (ev) => {
    dbg("btn-record clicked; disabled=" + btnRecord.disabled);
    startRecording();
  });
  btnStop.addEventListener("click", (ev) => {
    dbg("btn-stop clicked");
    stopRecording();
  });
  dbg("button listeners attached");
  btnNewPrompt.addEventListener("click", () => {
    const list = window.TRAINING_PROMPTS || [];
    if (!list.length) return;
    let next = promptEl.textContent;
    let guard = 0;
    while (next === promptEl.textContent && guard++ < 20) {
      next = list[Math.floor(Math.random() * list.length)];
    }
    promptEl.textContent = next;
  });

  if (camDeviceSel) {
    camDeviceSel.addEventListener("change", async () => {
      localStorage.setItem("voice-cam-device", camDeviceSel.value);
      try { await ensureStream(true); } catch {}
    });
  }
  if (micDeviceSel) {
    micDeviceSel.addEventListener("change", async () => {
      localStorage.setItem("voice-mic-device", micDeviceSel.value);
      try { await ensureStream(true); } catch {}
    });
  }

  (async () => {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const cam = await navigator.permissions.query({ name: "camera" });
        const mic = await navigator.permissions.query({ name: "microphone" });
        dbg("permissions: camera=" + cam.state + " microphone=" + mic.state);
        if (cam.state === "denied" || mic.state === "denied") {
          dbgErr("Camera or mic permission is DENIED for this origin. Click the camera icon in the address bar and allow, then reload.");
        }
      } catch (err) {
        dbg("permissions query not supported: " + (err.message || err.name));
      }
    }
  })();

  populateDevices().then(() => dbg("populateDevices done"));

  // warm up preview
  dbg("warming up preview");
  ensureStream().then(() => dbg("preview warm-up OK")).catch((err) => {
    dbgErr("warm-up failed: " + (err.message || err.name || String(err)));
    if (status) status.textContent = "Camera or microphone blocked: " + (err.message || err.name);
  });
})();
