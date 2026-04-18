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
  const liveTranscriptEl = document.getElementById("live-transcript");
  const liveBiomarkerEl = document.getElementById("live-biomarker");
  const liveIndicator = document.getElementById("live-indicator");

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
    "train-status=" + !!status,
    "live-transcript=" + !!liveTranscriptEl);

  if (!btnRecord) {
    dbgErr("btn-record element missing — HTML is stale. Force reload with Cmd+Shift+R.");
    return;
  }

  let stream = null;
  let audioCtx = null;
  let workletNode = null;
  let analyser = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerId = null;
  let meterRaf = null;
  let streamWs = null;
  let currentSessionId = null;
  let finalTranscript = "";
  let liveWordsCount = 0;
  let pcmFramesSent = 0;
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
      dbgErr(msg);
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

      dbg("cams: " + cams.map((c) => c.label || c.deviceId).join(", "));
      dbg("mics: " + mics.map((m) => m.label || m.deviceId).join(", "));
    } catch (err) {
      dbgErr("enumerateDevices failed: " + (err.message || err.name));
    }
  }

  async function ensureStream(forceNew = false) {
    dbg("ensureStream enter; have stream=" + !!stream + " forceNew=" + forceNew);
    if (stream && !forceNew) return stream;
    if (stream && forceNew) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (!checkSecureContext()) throw new Error("insecure context");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("mediaDevices.getUserMedia not available");
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
      setTimeout(() => reject(new Error(`getUserMedia timed out after ${timeoutMs}ms — check permission popup`)), timeoutMs)
    );
    try {
      stream = await Promise.race([navigator.mediaDevices.getUserMedia(constraints), timedOut]);
    } catch (err) {
      dbgErr("getUserMedia failed: " + (err.name || "") + " " + (err.message || String(err)));
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
    }
    await populateDevices();
    return stream;
  }

  // --------------- Live streaming pipeline ---------------

  async function setupAudioPipeline(s) {
    // Try to create AudioContext at 16 kHz so the worklet doesn't need to resample.
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch (err) {
      dbg("AudioContext(sampleRate:16000) rejected, using default: " + err.message);
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
    dbg("AudioContext rate=" + audioCtx.sampleRate + " state=" + audioCtx.state);

    const source = audioCtx.createMediaStreamSource(s);

    // meter analyser for the mini bar
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    const tickMeter = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length) || 1e-9;
      const dbfs = 20 * Math.log10(rms);
      miniBar.style.width = pct(dbfs) + "%";
      const elapsed = (performance.now() - startedAt) / 1000;
      if (elapsed > 0) volumeTimeline.push({ t: +elapsed.toFixed(3), dbfs: +dbfs.toFixed(2) });
      meterRaf = requestAnimationFrame(tickMeter);
    };
    tickMeter();

    // PCM worklet
    try {
      await audioCtx.audioWorklet.addModule("/static/js/pcm-worklet.js");
    } catch (err) {
      dbgErr("worklet addModule failed: " + (err.message || err.name));
      throw err;
    }
    workletNode = new AudioWorkletNode(audioCtx, "pcm-processor", {
      processorOptions: { targetRate: 16000, chunkSamples: 2048 },
    });
    workletNode.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === "init") {
        dbg("worklet init sourceRate=" + ev.data.sourceRate + " targetRate=" + ev.data.targetRate + " ratio=" + ev.data.ratio.toFixed(2));
        return;
      }
      const buffer = ev.data;
      if (buffer instanceof ArrayBuffer && streamWs && streamWs.readyState === WebSocket.OPEN) {
        streamWs.send(buffer);
        pcmFramesSent += 1;
        if (pcmFramesSent <= 3 || pcmFramesSent % 50 === 0) {
          dbg("pcm frame " + pcmFramesSent + " bytes=" + buffer.byteLength);
        }
      }
    };
    source.connect(workletNode);
    // must connect to destination even if muted, or the processor may not run
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    workletNode.connect(silent);
    silent.connect(audioCtx.destination);
    dbg("audio worklet connected");
  }

  async function pingServer() {
    try {
      const r = await fetch("/config", { cache: "no-store" });
      dbg("server alive, /config status=" + r.status);
    } catch (err) {
      dbgErr("server unreachable on /config: " + (err.message || err.name));
      throw new Error("server not running on " + location.origin);
    }
  }

  function connectStreamWs() {
    return new Promise(async (resolve, reject) => {
      try { await pingServer(); }
      catch (err) { reject(err); return; }

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${location.host}/ws/train/stream`;
      dbg("connecting stream WS " + url);
      streamWs = new WebSocket(url);
      streamWs.binaryType = "arraybuffer";

      let readyResolved = false;
      streamWs.onopen = () => dbg("stream WS open");
      streamWs.onerror = (e) => {
        dbgErr("stream WS error event (browsers do not expose detail; see terminal logs for the real reason)");
        if (!readyResolved) reject(new Error("stream WS error — check terminal for `[ws/train/stream]` logs"));
      };
      streamWs.onclose = (e) => {
        dbg("stream WS closed code=" + e.code + " reason=" + (e.reason || ""));
        setLiveIndicator(false);
        if (!readyResolved) {
          let hint = "";
          if (e.code === 1006) hint = " (1006 = abnormal close; most common cause: endpoint missing or server crashed during handshake — restart `python app.py`)";
          reject(new Error("stream WS closed before ready code=" + e.code + hint));
        }
      };
      streamWs.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === "ready") {
          currentSessionId = msg.session_id;
          setLiveIndicator(true, "connected");
          dbg("stream ready session=" + msg.session_id + " tx=" + msg.transcription_enabled + " bio=" + msg.biomarker_enabled);
          if (!msg.transcription_enabled && msg.transcription_error) dbgErr("transcription disabled: " + msg.transcription_error);
          if (!msg.biomarker_enabled && msg.biomarker_error && msg.biomarker_error !== "disabled") dbgErr("biomarker disabled: " + msg.biomarker_error);
          readyResolved = true;
          resolve(msg);
        } else if (msg.type === "partial") {
          showPartial(msg.text);
        } else if (msg.type === "final") {
          appendFinal(msg.text, msg.words || []);
        } else if (msg.type === "policy") {
          showPolicy(msg.result);
        } else if (msg.type === "done") {
          dbg("stream done session=" + msg.session_id + " words=" + msg.words);
        }
      };

      // timeout waiting for ready
      setTimeout(() => {
        if (!readyResolved) reject(new Error("stream WS ready timeout"));
      }, 8000);
    });
  }

  function setLiveIndicator(on, label) {
    if (!liveIndicator) return;
    liveIndicator.classList.toggle("on", !!on);
    liveIndicator.textContent = on ? "LIVE " + (label || "") : "offline";
  }

  function showPartial(text) {
    if (!liveTranscriptEl) return;
    const partialSpan = liveTranscriptEl.querySelector(".partial") || (() => {
      const s = document.createElement("span");
      s.className = "partial";
      liveTranscriptEl.appendChild(s);
      return s;
    })();
    partialSpan.textContent = " " + text;
    liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
  }

  function appendFinal(text, words) {
    if (!liveTranscriptEl) return;
    const old = liveTranscriptEl.querySelector(".partial");
    if (old) old.remove();
    const finalSpan = document.createElement("span");
    finalSpan.className = "final";
    finalSpan.textContent = text + " ";
    liveTranscriptEl.appendChild(finalSpan);
    finalTranscript = (finalTranscript + " " + text).trim();
    liveWordsCount += (words && words.length) || 0;
    liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
    dbg("final [" + (words?.length || 0) + " words]: " + text.slice(0, 80));
  }

  // ---- Biomarker rendering (user-facing) ----

  // Biomarkers where HIGHER = worse (red at top)
  const NEGATIVE_BIOMARKERS = new Set([
    "distress", "stress", "anxiety", "anger", "frustration", "fatigue",
    "agitation", "tension", "sadness", "risk", "hostility", "depression",
    "cognitive_load", "valence_negative",
  ]);
  // Biomarkers where HIGHER = better (green at top)
  const POSITIVE_BIOMARKERS = new Set([
    "confidence", "engagement", "calmness", "positivity", "happiness",
    "warmth", "focus", "energy", "clarity", "assurance", "wellbeing",
    "presence", "valence_positive",
  ]);

  const liveCoachingEl = document.getElementById("live-coaching");
  const liveBiomarkerBarsEl = document.getElementById("live-biomarker-bars");
  let lastBiomarkerHash = "";

  function coachingForBiomarkers(scores) {
    /* Produce ONE user-facing, imperative line keyed on the biggest signal.
       Priorities: alerts first, then corrections, then encouragement. */
    const get = (k) => (k in scores ? scores[k] : null);
    const distress = get("distress") ?? get("anxiety") ?? get("stress");
    const frustration = get("frustration") ?? get("anger");
    const confidence = get("confidence") ?? get("assurance");
    const engagement = get("engagement") ?? get("energy") ?? get("presence");
    const fatigue = get("fatigue");
    const risk = get("risk");

    if (risk != null && risk >= 0.6) return { text: "Pause. Take one slow breath before continuing.", tone: "alert" };
    if (distress != null && distress >= 0.65) return { text: "You are sounding tense. Slow down and soften your tone.", tone: "alert" };
    if (distress != null && distress >= 0.45) return { text: "Take a breath. Let your pace settle.", tone: "warn" };
    if (frustration != null && frustration >= 0.5) return { text: "Drop the edge. Try a warmer tone.", tone: "warn" };
    if (confidence != null && confidence <= 0.3) return { text: "Speak with a touch more certainty.", tone: "warn" };
    if (fatigue != null && fatigue >= 0.6) return { text: "Lift a little. Brighten your voice.", tone: "warn" };
    if (engagement != null && engagement <= 0.3) return { text: "Bring more colour. Vary your pitch.", tone: "warn" };
    if (confidence != null && confidence >= 0.7) return { text: "Strong, grounded delivery. Keep it.", tone: "good" };
    if (engagement != null && engagement >= 0.7) return { text: "Great energy. You have their attention.", tone: "good" };
    return null;
  }

  function flattenScores(obj, out = {}, depth = 0) {
    /* Walk the Thymia result; collect any numeric 0-1 values under a
       descriptive key. Keys with 'score', 'level', 'probability' suffixes
       get their suffix stripped. */
    if (!obj || typeof obj !== "object" || depth > 4) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && v >= 0 && v <= 1) {
        const key = String(k)
          .replace(/_?(score|level|probability|prob|value)$/i, "")
          .replace(/^_+|_+$/g, "")
          .toLowerCase() || String(k).toLowerCase();
        // prefer first occurrence
        if (!(key in out)) out[key] = v;
      } else if (v && typeof v === "object") {
        flattenScores(v, out, depth + 1);
      }
    }
    return out;
  }

  function renderBiomarkerBar(key, value) {
    const el = document.createElement("div");
    el.className = "bio-bar";
    const pctVal = Math.round(value * 100);

    let cls = "mid";
    if (POSITIVE_BIOMARKERS.has(key)) {
      cls = value < 0.34 ? "good-low" : value < 0.67 ? "good-mid" : "good-high";
    } else if (NEGATIVE_BIOMARKERS.has(key)) {
      cls = value < 0.34 ? "low" : value < 0.67 ? "mid" : "high";
    } else {
      cls = value < 0.34 ? "low" : value < 0.67 ? "mid" : "high";
    }

    el.innerHTML = `
      <div class="bio-bar-head">
        <span class="k">${key.replace(/_/g, " ")}</span>
        <span class="v">${pctVal}%</span>
      </div>
      <div class="bio-bar-track"><div class="bio-bar-fill ${cls}" style="width:${pctVal}%"></div></div>
    `;
    return el;
  }

  function showPolicy(result) {
    // The root payload varies across Thymia Sentinel versions. Normalise by
    // preferring .result, else using root.
    const root = (result && (result.result || result)) || {};

    // 1) collect user-facing text from Thymia if present, else derive from scores.
    const actions = root.recommended_actions || {};
    const userText = actions.for_user || actions.user || actions.self || "";

    // 2) extract every numeric 0-1 signal we can find
    const scores = flattenScores(root);
    // remove noisy keys that aren't real biomarkers
    delete scores["confidence_threshold"];
    delete scores["min_confidence"];
    delete scores["max_confidence"];

    // 3) pick a ranked subset to render as bars (cap at 6 so the panel stays tight)
    const preferredOrder = [
      "distress", "stress", "anxiety", "frustration", "fatigue",
      "confidence", "engagement", "energy", "calmness", "warmth", "positivity", "presence",
    ];
    const seen = new Set();
    const ordered = [];
    for (const k of preferredOrder) {
      if (k in scores && !seen.has(k)) { ordered.push(k); seen.add(k); }
    }
    for (const k of Object.keys(scores)) {
      if (!seen.has(k)) { ordered.push(k); seen.add(k); }
    }
    const top = ordered.slice(0, 6);

    // hash to avoid redundant re-renders
    const hash = JSON.stringify(top.map((k) => [k, Math.round(scores[k] * 100)])) + "|" + userText;
    if (hash === lastBiomarkerHash) return;
    lastBiomarkerHash = hash;

    // render bars
    if (liveBiomarkerBarsEl) {
      liveBiomarkerBarsEl.innerHTML = "";
      for (const k of top) {
        liveBiomarkerBarsEl.appendChild(renderBiomarkerBar(k, scores[k]));
      }
    }

    // render coaching line
    const derived = coachingForBiomarkers(scores);
    let coachingText = userText || (derived && derived.text) || "";
    let tone = derived ? derived.tone : "info";
    const classification = root.classification || root.risk_level || root.state || "";
    if (liveCoachingEl && coachingText) {
      const chip = classification ? `<span class="chip ${tone}">${classification}</span>` : "";
      liveCoachingEl.classList.add("fade");
      setTimeout(() => {
        liveCoachingEl.innerHTML = coachingText + chip;
        liveCoachingEl.classList.remove("fade");
      }, 150);
    } else if (liveCoachingEl && !coachingText && top.length) {
      liveCoachingEl.textContent = "Signals coming in — keep going.";
    }

    // keep the raw meta line as a debug artefact (hidden by default)
    if (liveBiomarkerEl) {
      liveBiomarkerEl.hidden = false;
      liveBiomarkerEl.textContent = JSON.stringify({ top, userText, classification }).slice(0, 300);
    }

    dbg("policy scores: " + top.map((k) => `${k}=${scores[k].toFixed(2)}`).join(" ") + (coachingText ? " | tip: " + coachingText.slice(0, 60) : ""));
  }

  function showError(msg) {
    dbgErr(msg);
    if (status) {
      status.textContent = msg;
      status.style.color = "#ff453a";
      status.style.fontWeight = "500";
    }
  }

  // --------------- Recording lifecycle ---------------

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

  async function startRecording() {
    dbg("startRecording called");
    let s;
    try {
      s = await ensureStream();
    } catch (err) {
      showError("Cannot start: " + (err.message || err.name || String(err)));
      return;
    }
    tipEl.textContent = "Listening…";
    btnRecord.disabled = true;
    btnStop.disabled = false;
    status.textContent = "";
    status.style.color = "";
    chunks = [];
    volumeTimeline = [];
    finalTranscript = "";
    liveWordsCount = 0;
    pcmFramesSent = 0;
    currentSessionId = null;
    if (liveTranscriptEl) liveTranscriptEl.innerHTML = "";
    if (liveBiomarkerEl) liveBiomarkerEl.textContent = "—";

    try {
      await connectStreamWs();
      await setupAudioPipeline(s);

      const mime = pickRecorderMime();
      dbg("MediaRecorder mime: " + (mime || "(default)"));
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = handleStop;
      recorder.onerror = (e) => dbgErr("recorder error: " + (e.error && e.error.name));
      recorder.start(250);
      dbg("recorder started state=" + recorder.state);
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

  async function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    dbg("stopRecording called");
    btnStop.disabled = true;

    try { recorder.stop(); } catch (err) { dbgErr("recorder.stop error: " + err.message); }
    if (meterRaf) cancelAnimationFrame(meterRaf);
    clearInterval(timerId);

    if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch {} audioCtx = null; }

    if (streamWs && streamWs.readyState === WebSocket.OPEN) {
      try { streamWs.send(JSON.stringify({ type: "stop" })); } catch {}
      // Give the server a beat to write its files before we close.
      await new Promise((r) => setTimeout(r, 600));
      try { streamWs.close(); } catch {}
    }
  }

  async function handleStop() {
    const elapsedSecs = (performance.now() - startedAt) / 1000;
    if (elapsedSecs < window.TRAINING_MIN) {
      status.textContent = `Too short. Record for at least ${window.TRAINING_MIN} seconds.`;
      btnRecord.disabled = false;
      tipEl.textContent = "Press record when you are ready.";
      return;
    }
    if (!currentSessionId) {
      showError("No session id from stream; cannot attach video.");
      btnRecord.disabled = false;
      return;
    }

    status.textContent = "Uploading video…";
    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    dbg("uploading blob size=" + blob.size + " session=" + currentSessionId);

    const form = new FormData();
    form.append("video", blob, "video.webm");
    form.append("audio", blob, "audio.webm");
    form.append("volume", JSON.stringify(volumeTimeline));
    form.append("transcript_hint", finalTranscript);
    form.append("session_id", currentSessionId);

    try {
      const resp = await fetch("/train/submit", { method: "POST", body: form });
      const data = await resp.json();
      dbg("submit ok session=" + data.session_id);
      status.textContent = "Analysing…";
      location.href = `/review/${data.session_id}`;
    } catch (err) {
      showError("Upload failed: " + err);
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
          dbgErr("Camera or mic permission DENIED for this origin. Click the camera icon in the address bar and allow, then reload.");
        }
      } catch (err) {
        dbg("permissions query not supported");
      }
    }
  })();

  populateDevices().then(() => dbg("populateDevices done"));

  dbg("warming up preview");
  ensureStream().then(() => dbg("preview warm-up OK")).catch((err) => {
    dbgErr("warm-up failed: " + (err.message || err.name || String(err)));
    if (status) status.textContent = "Camera or microphone blocked: " + (err.message || err.name);
  });
})();
