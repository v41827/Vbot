(() => {
  const el = (id) => document.getElementById(id);
  const logEl = el("log");
  const stateLabel = el("state-label");
  const dbfsNow = el("dbfs-now");
  const dbfsAmbient = el("dbfs-ambient");
  const meterBar = el("meter-bar");
  const meter = el("meter");
  const flashOverlay = el("flash-overlay");
  const statusLine = el("status-line");
  const chipPhones = el("chip-phones");
  const chipSources = el("chip-sources");
  const chipDashboards = el("chip-dashboards");

  const btnMic = el("btn-mic");
  const btnCalibrate = el("btn-calibrate");
  const btnReset = el("btn-reset");
  const btnTestLoud = el("btn-test-loud");
  const btnTestQuiet = el("btn-test-quiet");
  const micDeviceSel = el("mic-device");

  const markers = {
    ambient: el("meter-ambient"),
    speaking: el("meter-speaking"),
    quiet: el("meter-quiet"),
    loud: el("meter-loud"),
  };

  let config = null;
  let dashboardWs = null;
  let sourceWs = null;
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let rafId = null;

  const MIN_DB = -80;
  const MAX_DB = 0;

  async function loadConfig() {
    const resp = await fetch("/config");
    config = await resp.json();
  }

  let sentCount = 0;
  let lastRateLog = performance.now();
  let rateWindowCount = 0;

  function connectDashboard() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/dashboard`;
    console.log("[dashboard] connecting", url);
    dashboardWs = new WebSocket(url);
    dashboardWs.onopen = () => {
      console.log("[dashboard] WS open");
      setStatus("Dashboard connected");
    };
    dashboardWs.onerror = (e) => {
      console.error("[dashboard] WS error", e);
    };
    dashboardWs.onclose = (e) => {
      console.warn("[dashboard] WS closed", e.code, e.reason);
      setStatus("Dashboard disconnected. Reconnecting…");
      setTimeout(connectDashboard, 1500);
    };
    dashboardWs.onmessage = (e) => handleDashboardMessage(JSON.parse(e.data));
  }

  function connectSource() {
    if (sourceWs && sourceWs.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/source`;
    console.log("[source] connecting", url);
    sourceWs = new WebSocket(url);
    sourceWs.onopen = () => {
      console.log("[source] WS open");
      addLog("Source websocket open");
    };
    sourceWs.onerror = (e) => {
      console.error("[source] WS error", e);
      addLog("Source websocket error (see console)");
    };
    sourceWs.onclose = (e) => {
      console.warn("[source] WS closed", e.code, e.reason);
    };
  }

  function handleDashboardMessage(msg) {
    if (msg.type === "meter") {
      updateMeter(msg);
    } else if (msg.type === "buzz") {
      flash(msg.colour);
      addLog(`${msg.kind === "loud" ? "Loud" : "Quiet"} buzz — ${msg.vibration_ms}ms`);
    } else if (msg.type === "calibration") {
      if (msg.status === "started") {
        setStatus("Calibrating ambient level. Stay quiet for a few seconds…");
      } else if (msg.status === "complete") {
        setStatus(`Ambient set to ${msg.ambient_dbfs} dBFS`);
        addLog(`Calibration complete: ${msg.ambient_dbfs} dBFS`);
      } else if (msg.status === "reset") {
        setStatus(`Ambient reset to default (${msg.ambient_dbfs} dBFS)`);
      }
    } else if (msg.type === "transcript") {
      // optional: show live transcript
    } else if (msg.type === "status" || msg.type === "hello") {
      updateChips(msg);
    }
  }

  function updateChips(s) {
    if (typeof s.phones === "number") chipPhones.textContent = `Phones: ${s.phones}`;
    if (typeof s.sources === "number") chipSources.textContent = `Sources: ${s.sources}`;
    if (typeof s.dashboards === "number") chipDashboards.textContent = `Dashboards: ${s.dashboards}`;
  }

  function toPct(db) {
    const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
    return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
  }

  function updateMeter(msg) {
    const pct = toPct(msg.dbfs);
    meterBar.style.height = pct + "%";
    dbfsNow.textContent = msg.dbfs.toFixed(1);
    dbfsAmbient.textContent = msg.ambient_dbfs.toFixed(1);
    stateLabel.textContent = msg.state;
    stateLabel.className = msg.state;

    const t = msg.thresholds || {};
    if (t.ambient != null) markers.ambient.style.bottom = toPct(t.ambient) + "%";
    if (t.speaking != null) markers.speaking.style.bottom = toPct(t.speaking) + "%";
    if (t.quiet_floor != null) markers.quiet.style.bottom = toPct(t.quiet_floor) + "%";
    if (t.loud != null) markers.loud.style.bottom = toPct(t.loud) + "%";

    markers.ambient.setAttribute("data-label", `ambient ${t.ambient ?? ""}`);
    markers.speaking.setAttribute("data-label", `speaking ${t.speaking ?? ""}`);
    markers.quiet.setAttribute("data-label", `quiet floor ${t.quiet_floor ?? ""}`);
    markers.loud.setAttribute("data-label", `loud ${t.loud ?? ""}`);
  }

  function flash(colour) {
    flashOverlay.style.background = colour;
    flashOverlay.classList.add("on");
    setTimeout(() => flashOverlay.classList.remove("on"), 400);
  }

  function addLog(text) {
    const li = document.createElement("li");
    const time = new Date().toLocaleTimeString("en-GB");
    li.innerHTML = `<span class="t">${time}</span><span>${text}</span>`;
    logEl.prepend(li);
    while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
  }

  function setStatus(text) { statusLine.textContent = text; }

  // ---------------- Microphone ----------------

  function checkSecureContext() {
    const host = location.hostname;
    const isSecure = window.isSecureContext ||
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isSecure) {
      const msg = `Microphone blocked: browsers require HTTPS or localhost. You are on ${location.origin}. Open http://localhost:8000 on this machine instead, or serve over HTTPS.`;
      console.error("[mic] " + msg);
      setStatus(msg);
      addLog("Insecure context: mic blocked");
      return false;
    }
    return true;
  }

  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const prev = micDeviceSel.value;
      micDeviceSel.innerHTML = "";
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "System default";
      micDeviceSel.appendChild(defaultOpt);
      inputs.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        micDeviceSel.appendChild(opt);
      });
      const saved = localStorage.getItem("voice-mic-device");
      if (saved && inputs.some((d) => d.deviceId === saved)) {
        micDeviceSel.value = saved;
      } else if (prev && inputs.some((d) => d.deviceId === prev)) {
        micDeviceSel.value = prev;
      }
      console.log("[mic] input devices:", inputs.map((d) => d.label || d.deviceId));
    } catch (err) {
      console.warn("[mic] enumerateDevices failed", err);
    }
  }

  async function startMic() {
    if (audioCtx) return;
    if (!checkSecureContext()) return;

    const deviceId = micDeviceSel ? micDeviceSel.value : "";
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    console.log("[mic] requesting getUserMedia", constraints);
    try {
      micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error("[mic] getUserMedia failed", err);
      setStatus("Microphone blocked: " + (err.message || err.name));
      addLog("Mic permission denied");
      return;
    }
    await populateDevices();
    console.log("[mic] stream acquired, tracks:",
      micStream.getAudioTracks().map((t) => ({ label: t.label, muted: t.muted, enabled: t.enabled })));

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      console.log("[mic] resuming suspended AudioContext");
      try { await audioCtx.resume(); } catch (e) { console.warn("resume failed", e); }
    }
    console.log("[mic] AudioContext state:", audioCtx.state, "sampleRate:", audioCtx.sampleRate);

    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    connectSource();

    const buf = new Float32Array(analyser.fftSize);
    let lastSend = 0;
    let loggedFirstSend = false;

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length) || 1e-9;
      const dbfs = 20 * Math.log10(rms);
      const now = performance.now();
      if (now - lastSend >= 50 && sourceWs && sourceWs.readyState === WebSocket.OPEN) {
        sourceWs.send(JSON.stringify({ type: "volume", dbfs, t: now / 1000 }));
        sentCount += 1;
        rateWindowCount += 1;
        lastSend = now;
        if (!loggedFirstSend) {
          console.log("[mic] first volume sent", dbfs.toFixed(1), "dBFS");
          addLog("First volume sent to server");
          loggedFirstSend = true;
        }
      }
      if (now - lastRateLog >= 1000) {
        const rate = rateWindowCount;
        rateWindowCount = 0;
        lastRateLog = now;
        if (sourceWs && sourceWs.readyState !== WebSocket.OPEN) {
          console.warn("[mic] sample rate", rate, "but source WS not open (state=" + (sourceWs && sourceWs.readyState) + ")");
        }
        updateSentIndicator(rate);
      }
      rafId = requestAnimationFrame(tick);
    };
    tick();
    btnMic.textContent = "Stop microphone";
    btnMic.classList.remove("primary");
    setStatus("Microphone live");
    addLog("Microphone started");
  }

  function updateSentIndicator(rate) {
    if (!chipSources) return;
    const label = `Sent: ${sentCount} (${rate}/s)`;
    const el = document.getElementById("chip-sent") || (() => {
      const d = document.createElement("div");
      d.className = "chip";
      d.id = "chip-sent";
      chipSources.parentElement.appendChild(d);
      return d;
    })();
    el.textContent = label;
  }

  function stopMic() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (audioCtx) audioCtx.close();
    audioCtx = null;
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    if (sourceWs) sourceWs.close();
    sourceWs = null;
    btnMic.textContent = "Start microphone";
    btnMic.classList.add("primary");
    setStatus("Microphone stopped");
  }

  btnMic.addEventListener("click", () => {
    if (audioCtx) stopMic();
    else startMic();
  });

  if (micDeviceSel) {
    micDeviceSel.addEventListener("change", async () => {
      localStorage.setItem("voice-mic-device", micDeviceSel.value);
      if (audioCtx) {
        console.log("[mic] device changed, restarting");
        stopMic();
        await new Promise((r) => setTimeout(r, 200));
        startMic();
      }
    });
    populateDevices();
    if (navigator.mediaDevices && "ondevicechange" in navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", populateDevices);
    }
  }

  btnCalibrate.addEventListener("click", async () => {
    await fetch("/calibrate/start", { method: "POST" });
  });
  btnReset.addEventListener("click", async () => {
    await fetch("/calibrate/reset", { method: "POST" });
  });
  btnTestLoud.addEventListener("click", async () => {
    await fetch("/calibrate/reset", { method: "POST" });
    // fake a burst by briefly injecting a large dBFS signal
    if (sourceWs && sourceWs.readyState === WebSocket.OPEN) {
      sourceWs.send(JSON.stringify({ type: "volume", dbfs: -15 }));
    } else {
      addLog("Start the microphone first, then press test.");
    }
  });
  btnTestQuiet.addEventListener("click", async () => {
    if (sourceWs && sourceWs.readyState === WebSocket.OPEN) {
      const amb = parseFloat(dbfsAmbient.textContent) || -50;
      sourceWs.send(JSON.stringify({ type: "volume", dbfs: amb + 8 }));
    } else {
      addLog("Start the microphone first, then press test.");
    }
  });

  loadConfig().then(connectDashboard);
})();
