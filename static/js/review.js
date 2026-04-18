(() => {
  const loading = document.getElementById("loading");
  const reviewEl = document.getElementById("review");
  const failure = document.getElementById("failure");
  const failureDetail = document.getElementById("failure-detail");

  const scoreNumber = document.getElementById("score-number");
  const scoreSummary = document.getElementById("score-summary");
  const strengthsEl = document.getElementById("strengths");
  const tipsEl = document.getElementById("tips");
  const video = document.getElementById("video");
  const transcriptEl = document.getElementById("transcript");
  const emotionTrack = document.getElementById("emotion-track");
  const biomarkersEl = document.getElementById("biomarkers");
  const volumeCanvas = document.getElementById("volume-canvas");

  const sessionId = window.SESSION_ID;
  let wordEls = [];
  let wordsData = [];
  let duration = 0;

  const EMOTION_COLOURS = {
    neutral: "#8e8e93",
    calm: "#64d2ff",
    happy: "#30d158",
    excited: "#ffd60a",
    anxious: "#ff9f0a",
    frustrated: "#ff453a",
    sad: "#5e5ce6",
    uncertain: "#bf5af2",
  };

  async function poll() {
    let attempts = 0;
    while (attempts < 60) {
      const r = await fetch(`/session/${sessionId}`);
      const data = await r.json();
      const s = data.status?.status;
      if (s === "ready") { render(data.report); return; }
      if (s === "failed") {
        loading.hidden = true;
        failure.hidden = false;
        failureDetail.textContent = data.status.error || "Unknown error";
        return;
      }
      attempts += 1;
      await new Promise((r) => setTimeout(r, 1500));
    }
    loading.hidden = true;
    failure.hidden = false;
    failureDetail.textContent = "Timed out waiting for analysis.";
  }

  function render(report) {
    loading.hidden = true;
    reviewEl.hidden = false;

    if (report.video_file) {
      video.src = `/session/${sessionId}/media/${report.video_file}`;
    } else if (report.audio_file) {
      video.src = `/session/${sessionId}/media/${report.audio_file}`;
    }

    duration = report.duration_seconds || 0;
    video.addEventListener("loadedmetadata", () => {
      if (!duration || duration < 0.1) duration = video.duration || 0;
    });
    video.addEventListener("timeupdate", highlightWord);

    // Score + summary
    const r = report.report || {};
    scoreNumber.textContent = r.score ? r.score : "—";
    scoreSummary.textContent = r.summary || "";

    strengthsEl.innerHTML = "";
    (r.strengths || []).forEach((s) => {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = s;
      strengthsEl.appendChild(b);
    });

    // Tips
    tipsEl.innerHTML = "";
    (r.tips || []).forEach((t) => {
      const li = document.createElement("li");
      const cat = document.createElement("div");
      cat.className = "cat";
      cat.textContent = t.category || "";
      const body = document.createElement("div");
      body.textContent = t.text;
      li.appendChild(cat);
      li.appendChild(body);
      tipsEl.appendChild(li);
    });

    // Transcript
    transcriptEl.innerHTML = "";
    wordsData = (report.transcript && report.transcript.words) || [];
    wordEls = wordsData.map((w) => {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = w.text + " ";
      span.dataset.start = w.start;
      span.addEventListener("click", () => {
        if (video && !Number.isNaN(w.start)) {
          video.currentTime = w.start;
          video.play().catch(() => {});
        }
      });
      transcriptEl.appendChild(span);
      return span;
    });
    if (!wordsData.length && report.transcript?.text) {
      transcriptEl.textContent = report.transcript.text;
    }

    // Emotion dots
    emotionTrack.innerHTML = "";
    const timeline = report.emotion?.timeline || [];
    timeline.forEach((p) => {
      if (!duration) return;
      const dot = document.createElement("div");
      dot.className = "emotion-dot";
      dot.style.left = ((p.t / duration) * 100) + "%";
      dot.style.background = EMOTION_COLOURS[p.label] || "#8e8e93";
      dot.title = `${p.label} (v=${p.valence.toFixed(2)}, a=${p.arousal.toFixed(2)})`;
      dot.addEventListener("click", () => {
        video.currentTime = p.t;
        video.play().catch(() => {});
      });
      emotionTrack.appendChild(dot);
    });

    // Volume canvas
    drawVolume(report.volume_timeline || []);

    // Biomarkers
    biomarkersEl.innerHTML = "";
    const b = report.biomarker || {};
    const entries = [
      ["Pace (wpm)", b.pace_wpm, (v) => v?.toFixed(0)],
      ["Filler rate", b.filler_rate, (v) => (v * 100).toFixed(1) + "%"],
      ["Pitch mean (Hz)", b.pitch_mean_hz, (v) => v?.toFixed(0)],
      ["Pitch variability", b.pitch_variability, (v) => v?.toFixed(2)],
      ["Jitter", b.jitter, (v) => v?.toFixed(3)],
      ["Shimmer", b.shimmer, (v) => v?.toFixed(3)],
      ["Dominant emotion", report.emotion?.dominant || "—", (v) => v],
    ];
    entries.forEach(([k, v, fmt]) => {
      if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return;
      const div = document.createElement("div");
      div.className = "biomarker";
      div.innerHTML = `<div class="k">${k}</div><div class="v">${fmt(v)}</div>`;
      biomarkersEl.appendChild(div);
    });
    if (!biomarkersEl.children.length) {
      const div = document.createElement("div");
      div.className = "biomarker";
      div.innerHTML = `<div class="k">Signals</div><div class="v">collected</div>`;
      biomarkersEl.appendChild(div);
    }
  }

  function drawVolume(points) {
    const dpr = window.devicePixelRatio || 1;
    const rect = volumeCanvas.getBoundingClientRect();
    volumeCanvas.width = rect.width * dpr;
    volumeCanvas.height = rect.height * dpr;
    const ctx = volumeCanvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!points.length) return;

    const dur = points[points.length - 1].t || 1;
    const minDb = -80, maxDb = -10;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = (p.t / dur) * rect.width;
      const d = Math.max(minDb, Math.min(maxDb, p.dbfs));
      const y = rect.height - ((d - minDb) / (maxDb - minDb)) * rect.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const grad = ctx.createLinearGradient(0, 0, rect.width, 0);
    grad.addColorStop(0, "#0a84ff");
    grad.addColorStop(1, "#64d2ff");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();

    // fill under
    ctx.lineTo(rect.width, rect.height);
    ctx.lineTo(0, rect.height);
    ctx.closePath();
    ctx.fillStyle = "rgba(10, 132, 255, 0.12)";
    ctx.fill();
  }

  function highlightWord() {
    if (!wordEls.length) return;
    const t = video.currentTime;
    let active = -1;
    for (let i = 0; i < wordsData.length; i++) {
      if (t >= wordsData[i].start && t <= wordsData[i].end + 0.05) { active = i; break; }
      if (t < wordsData[i].start) break;
    }
    wordEls.forEach((el, i) => el.classList.toggle("active", i === active));
  }

  poll();
})();
