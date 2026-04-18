/* ui-train.jsx — Real-data wrapper for the new Buzzline TrainScreen.
 *
 * - Replaces the mock `useStream` from /ui/stream.jsx with a real hook that:
 *   - opens the camera + mic
 *   - streams PCM to /ws/train/stream (Speechmatics RT + Thymia Sentinel)
 *   - drives the Orb / waveform / transcript / coaching line
 *   - records video+audio via MediaRecorder for the review page
 * - On stop (play-button toggled off), uploads and redirects to /review/{id}.
 */

(() => {
  const $err = document.getElementById('train-error');
  const $dbg = document.getElementById('train-debug');
  const $scrim = document.getElementById('loading-scrim');

  function showError(msg) {
    console.error('[ui-train]', msg);
    if ($err) { $err.textContent = msg; $err.classList.add('show'); }
  }
  function clearError() { if ($err) $err.classList.remove('show'); }
  function dbg(msg) {
    console.log('[ui-train]', msg);
    if ($dbg) {
      const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
      $dbg.textContent = `[${t}] ${msg}\n` + $dbg.textContent;
      if ($dbg.textContent.length > 8000) $dbg.textContent = $dbg.textContent.slice(0, 8000);
    }
  }

  window.addEventListener('error', (e) => dbg('uncaught: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) =>
    dbg('unhandled promise: ' + ((e.reason && (e.reason.message || e.reason.name)) || String(e.reason))));

  // ─── helpers ──────────────────────────────────────────────────────────────

  const MIN_DB = -80, MAX_DB = 0;
  function levelFromDb(dbfs) {
    const c = Math.max(MIN_DB, Math.min(MAX_DB, dbfs));
    return (c - MIN_DB) / (MAX_DB - MIN_DB);
  }
  function countFillers(text) {
    return (text.match(/\b(um+|uh+|erm+)\b/gi) || []).length;
  }
  function calcWpm(text, elapsedSec) {
    if (!text || elapsedSec < 1) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.round((words / elapsedSec) * 60);
  }
  function wpmToPace(wpm) {
    // 100 wpm -> 0, 160 wpm -> 0.5, 220 wpm -> 1.0
    return Math.max(0, Math.min(1, (wpm - 100) / 120));
  }

  function flattenScores(obj, out = {}, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && v >= 0 && v <= 1) {
        const key = String(k)
          .replace(/_?(score|level|probability|prob|value)$/i, '')
          .replace(/^_+|_+$/g, '')
          .toLowerCase() || String(k).toLowerCase();
        if (!(key in out)) out[key] = v;
      } else if (v && typeof v === 'object') {
        flattenScores(v, out, depth + 1);
      }
    }
    return out;
  }

  function deriveEmotion(scores) {
    const distress = scores.distress ?? scores.anxiety ?? scores.stress;
    const confidence = scores.confidence ?? scores.assurance;
    const calmness = scores.calmness ?? scores.wellbeing;
    const fatigue = scores.fatigue;
    const engagement = scores.engagement ?? scores.energy ?? scores.presence;

    if (distress != null && distress >= 0.6) return 'anxious';
    if (fatigue != null && fatigue >= 0.55) return 'flat';
    if (engagement != null && engagement <= 0.3) return 'flat';
    if (calmness != null && calmness >= 0.55) return 'calm';
    if (confidence != null && confidence >= 0.6) return 'calm';
    return 'neutral';
  }

  function coachingFromPolicy(result) {
    const root = (result && (result.result || result)) || {};
    const actions = root.recommended_actions || {};
    const userText = actions.for_user || actions.user || actions.self || '';
    if (!userText) return null;
    const scores = flattenScores(root);
    const distress = scores.distress ?? scores.anxiety ?? scores.stress;
    const confidence = scores.confidence ?? scores.assurance;
    let kind = 'calm';
    if (distress != null && distress >= 0.5) kind = 'warn';
    if (confidence != null && confidence >= 0.65) kind = 'good';
    return { text: userText, kind };
  }

  function biomarkersFromScores(scores) {
    const distress = scores.distress ?? scores.anxiety ?? 0.2;
    const fatigue = scores.fatigue ?? 0.2;
    return {
      jitter: +(1.4 + distress * 2.8).toFixed(1),
      shimmer: +(0.15 + fatigue * 0.25).toFixed(2),
      hnr: +(16 - distress * 6).toFixed(0),
    };
  }

  // Normalise Thymia scores into a canonical signal set for the UI + coach.
  // Returns { distress, confidence, fatigue, engagement, calmness, ... } in 0..1.
  function canonicalSignals(scores) {
    if (!scores) return {};
    const pick = (...keys) => {
      for (const k of keys) {
        const v = scores[k];
        if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.min(1, v));
      }
      return null;
    };
    const out = {};
    const pairs = [
      ['distress',   ['distress', 'anxiety', 'stress', 'tension']],
      ['confidence', ['confidence', 'assurance', 'certainty']],
      ['fatigue',    ['fatigue', 'tiredness']],
      ['engagement', ['engagement', 'energy', 'presence', 'focus']],
      ['calmness',   ['calmness', 'wellbeing', 'positivity']],
      ['frustration',['frustration', 'anger', 'hostility']],
      ['risk',       ['risk']],
    ];
    for (const [k, syns] of pairs) {
      const v = pick(...syns);
      if (v != null) out[k] = v;
    }
    return out;
  }

  // ─── Coaching phrase library ────────────────────────────────────────────
  //
  // Each rule has:
  //   id:        unique string
  //   priority:  higher wins when multiple rules match in the same tick
  //   cooldownMs:wait this long before firing the same rule again
  //   condition: (signals) => bool
  //   phrases:   [{ text, kind }]  kind ∈ 'good' | 'warn' | 'alert' | 'calm'
  //
  // Phrases tell the user what to DO. Short, imperative, one breath.
  const COACHING_RULES = [
    {
      id: 'risk_alert', priority: 100, cooldownMs: 9000,
      condition: (s) => (s.signals.risk ?? 0) >= 0.6,
      phrases: [
        { text: 'Pause. One slow breath.',        kind: 'alert' },
        { text: 'Stop. Reset before continuing.', kind: 'alert' },
      ],
    },
    {
      id: 'distress_high', priority: 90, cooldownMs: 8000,
      condition: (s) => (s.signals.distress ?? 0) >= 0.65,
      phrases: [
        { text: 'Soften your tone. Slow it down.', kind: 'alert' },
        { text: 'Reduce the tension. Breathe.',    kind: 'alert' },
        { text: 'Ease up. You have time.',         kind: 'alert' },
      ],
    },
    {
      id: 'distress_mid', priority: 75, cooldownMs: 7000,
      condition: (s) => (s.signals.distress ?? 0) >= 0.45,
      phrases: [
        { text: 'Breathe. Let the pace settle.', kind: 'warn' },
        { text: 'Drop your shoulders.',          kind: 'warn' },
      ],
    },
    {
      id: 'frustration_high', priority: 85, cooldownMs: 8000,
      condition: (s) => (s.signals.frustration ?? 0) >= 0.55,
      phrases: [
        { text: 'Warm up the edge in your voice.', kind: 'warn' },
        { text: 'Soften the tone.',                kind: 'warn' },
      ],
    },
    {
      id: 'pace_fast', priority: 70, cooldownMs: 6500,
      condition: (s) => s.wpm > 200,
      phrases: [
        { text: 'Reduce your pace.', kind: 'warn' },
        { text: 'Slow down.',        kind: 'warn' },
        { text: 'Land your words.',  kind: 'warn' },
      ],
    },
    {
      id: 'pace_slow', priority: 65, cooldownMs: 7000,
      condition: (s) => s.wpm > 80 && s.wpm < 110,
      phrases: [
        { text: 'Pick up the pace.',        kind: 'warn' },
        { text: 'Increase your energy.',    kind: 'warn' },
        { text: 'A little more momentum.',  kind: 'warn' },
      ],
    },
    {
      id: 'fatigue_high', priority: 60, cooldownMs: 9000,
      condition: (s) => (s.signals.fatigue ?? 0) >= 0.6,
      phrases: [
        { text: 'Lift your voice.',      kind: 'warn' },
        { text: 'Brighten the tone.',    kind: 'warn' },
        { text: 'More colour, less flat.', kind: 'warn' },
      ],
    },
    {
      id: 'engagement_low', priority: 55, cooldownMs: 8000,
      condition: (s) => (s.signals.engagement ?? 1) <= 0.3,
      phrases: [
        { text: 'Vary your pitch.',   kind: 'warn' },
        { text: 'Bring more colour.', kind: 'warn' },
      ],
    },
    {
      id: 'volume_low', priority: 50, cooldownMs: 7000,
      condition: (s) => s.level > 0 && s.level < 0.2,
      phrases: [
        { text: 'Speak up.',         kind: 'warn' },
        { text: 'Lift your volume.', kind: 'warn' },
      ],
    },
    {
      id: 'volume_high', priority: 50, cooldownMs: 7000,
      condition: (s) => s.level > 0.88,
      phrases: [
        { text: 'Reduce your volume.', kind: 'warn' },
        { text: 'Softer.',             kind: 'warn' },
      ],
    },
    {
      id: 'confidence_high', priority: 30, cooldownMs: 12000,
      condition: (s) => (s.signals.confidence ?? 0) >= 0.7,
      phrases: [
        { text: 'Strong and grounded. Keep it.', kind: 'good' },
        { text: 'Well done.',                    kind: 'good' },
        { text: 'That\'s the voice.',            kind: 'good' },
      ],
    },
    {
      id: 'calm_good', priority: 25, cooldownMs: 12000,
      condition: (s) => (s.signals.calmness ?? 0) >= 0.6,
      phrases: [
        { text: 'Calm and clear.', kind: 'good' },
        { text: 'Nice cadence.',   kind: 'good' },
      ],
    },
    {
      id: 'engagement_high', priority: 25, cooldownMs: 12000,
      condition: (s) => (s.signals.engagement ?? 0) >= 0.75,
      phrases: [
        { text: 'Great energy. Keep it.',    kind: 'good' },
        { text: 'You have their attention.', kind: 'good' },
      ],
    },
  ].sort((a, b) => b.priority - a.priority);

  function createCoachingEngine(opts = {}) {
    const minGapMs = opts.minGapMs ?? 2800; // don't show two coachings within this window
    const lastFired = {};  // rule id → timestamp
    let lastShown = 0;
    // rotate through a rule's phrase list rather than pure random, so the
    // user doesn't see the same line back-to-back.
    const phraseCursor = {};

    return {
      tick(signals) {
        const now = Date.now();
        if (now - lastShown < minGapMs) return null;

        for (const rule of COACHING_RULES) {
          const last = lastFired[rule.id] || 0;
          if (now - last < rule.cooldownMs) continue;
          let match;
          try { match = rule.condition(signals); } catch { match = false; }
          if (!match) continue;

          const cursor = (phraseCursor[rule.id] || 0) % rule.phrases.length;
          const phrase = rule.phrases[cursor];
          phraseCursor[rule.id] = cursor + 1;
          lastFired[rule.id] = now;
          lastShown = now;
          return { id: now, text: phrase.text, kind: phrase.kind, rule: rule.id };
        }
        return null;
      },
    };
  }

  function pickMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function checkSecureContext() {
    const host = location.hostname;
    const isSecure = window.isSecureContext ||
      host === 'localhost' || host === 'localhost.localdomain' ||
      host === '127.0.0.1' || host === '::1';
    if (!isSecure) {
      showError(`Camera + mic blocked. Open http://localhost:${location.port || 8000}/train on this machine.`);
      return false;
    }
    return true;
  }

  // ─── pipeline lifecycle ──────────────────────────────────────────────────

  async function startPipeline(r, setState) {
    if (!checkSecureContext()) throw new Error('insecure context');

    // 1. getUserMedia — video for recording, audio for mic.
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    if (!r.active) { media.getTracks().forEach(t => t.stop()); return; }
    r.media = media;
    dbg('media acquired');

    // 2. AudioContext @ 16kHz (so worklet doesn't need to resample)
    let ac;
    try { ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); }
    catch { ac = new (window.AudioContext || window.webkitAudioContext)(); }
    if (ac.state === 'suspended') { try { await ac.resume(); } catch {} }
    if (!r.active) { try { await ac.close(); } catch {}; return; }
    r.audioCtx = ac;
    dbg('audio ctx rate=' + ac.sampleRate);

    const source = ac.createMediaStreamSource(media);

    // 3. Analyser for level metering
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    r.analyser = analyser;

    // 4. Connect /ws/train/stream (Speechmatics + Thymia)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/train/stream`);
    ws.binaryType = 'arraybuffer';
    r.ws = ws;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('stream WS ready timeout (8s)')), 8000);
      const onReady = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'ready') {
            clearTimeout(to);
            r.sessionId = m.session_id;
            dbg('stream ready session=' + m.session_id + ' tx=' + m.transcription_enabled + ' bio=' + m.biomarker_enabled);
            if (!m.transcription_enabled && m.transcription_error) {
              dbg('transcription disabled: ' + m.transcription_error);
            }
            if (!m.biomarker_enabled && m.biomarker_error && m.biomarker_error !== 'disabled') {
              dbg('biomarker disabled: ' + m.biomarker_error);
            }
            ws.removeEventListener('message', onReady);
            resolve(m);
          }
        } catch {}
      };
      ws.addEventListener('message', onReady);
      ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('stream WS error')); });
      ws.addEventListener('close', (e) => {
        clearTimeout(to);
        if (!r.sessionId) reject(new Error('stream WS closed before ready (code ' + e.code + ')'));
      });
    });

    if (!r.active) return;

    // 5. Main WS message handler (partial / final / policy)
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'partial') {
        setState(s => ({ ...s, partial: m.text || '' }));
      } else if (m.type === 'final') {
        const text = (m.text || '').trim();
        if (!text) return;
        r.finalTranscriptText = (r.finalTranscriptText + ' ' + text).trim();
        setState(s => ({
          ...s,
          transcript: (s.transcript ? s.transcript + ' ' : '') + text,
          partial: '',
          fillers: s.fillers + countFillers(text),
        }));
      } else if (m.type === 'policy') {
        const root = (m.result && (m.result.result || m.result)) || {};
        const scores = flattenScores(root);
        delete scores.confidence_threshold;
        delete scores.min_confidence;
        delete scores.max_confidence;
        const emotion = deriveEmotion(scores);
        const bios = biomarkersFromScores(scores);
        const signals = canonicalSignals(scores);
        // keep a live copy in the ref so the coaching tick loop can read it
        r.signals = signals;
        setState(s => ({
          ...s,
          emotion,
          biomarkers: bios,
          signals,
        }));
      }
    };

    // 6. AudioWorklet (PCM 16kHz → server)
    try {
      await ac.audioWorklet.addModule('/static/js/pcm-worklet.js');
    } catch (err) {
      throw new Error('audio worklet load failed: ' + (err.message || err.name));
    }
    if (!r.active) return;

    const worklet = new AudioWorkletNode(ac, 'pcm-processor', {
      processorOptions: { targetRate: 16000, chunkSamples: 2048 },
    });
    worklet.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'init') {
        dbg('worklet init sourceRate=' + ev.data.sourceRate + ' ratio=' + ev.data.ratio.toFixed(2));
        return;
      }
      const buf = ev.data;
      if (buf instanceof ArrayBuffer && r.ws && r.ws.readyState === WebSocket.OPEN) {
        r.ws.send(buf);
        r.pcmSent = (r.pcmSent || 0) + 1;
      }
    };
    source.connect(worklet);
    const silent = ac.createGain();
    silent.gain.value = 0;
    worklet.connect(silent);
    silent.connect(ac.destination);
    r.worklet = worklet;

    // 7. MediaRecorder for video+audio (saved as the session's video.webm)
    const mime = pickMime();
    const recorder = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    recorder.onerror = (e) => dbg('recorder error: ' + (e.error && e.error.name));
    recorder.start(250);
    r.recorder = recorder;
    dbg('recorder started mime=' + (mime || 'default'));

    // 8. Coaching tips WS (/ws/train) — gemma/ollama based rolling tips
    try {
      const coachWs = new WebSocket(`${proto}://${location.host}/ws/train`);
      coachWs.onopen = () => {
        r.coachInterval = setInterval(() => {
          if (coachWs.readyState !== WebSocket.OPEN) return;
          try {
            coachWs.send(JSON.stringify({ type: 'transcript', text: r.finalTranscriptText || '' }));
          } catch {}
        }, 4000);
      };
      coachWs.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'tip' && m.text) {
            const kind = m.category === 'good' ? 'good' : m.category === 'warn' ? 'warn' : 'calm';
            const coach = { id: Date.now(), text: m.text, kind, rule: 'ollama' };
            setState(s => ({ ...s, coaching: coach }));
            if (r.coachClearTo) clearTimeout(r.coachClearTo);
            r.coachClearTo = setTimeout(() => {
              setState(s => {
                if (s.coaching && s.coaching.id === coach.id) {
                  return { ...s, coaching: null };
                }
                return s;
              });
            }, COACHING_VISIBLE_MS);
          }
        } catch {}
      };
      r.coachWs = coachWs;
    } catch (err) {
      dbg('coach ws failed: ' + (err.message || err.name));
    }

    // 9. Level-meter / timer / coaching loop
    const buf = new Float32Array(analyser.fftSize);
    r.startTs = performance.now();
    r.signals = r.signals || {};
    r.currentLevel = 0;
    r.currentWpm = 0;
    const engine = createCoachingEngine();
    r.engine = engine;

    // Fire coach phrases at 1 Hz (independent of rAF). This keeps the decision
    // loop cheap and predictable, while the visual tick still runs at rAF.
    r.coachTick = setInterval(() => {
      if (!r.active) return;
      const sig = {
        wpm: r.currentWpm || 0,
        level: r.currentLevel || 0,
        signals: r.signals || {},
      };
      const coach = engine.tick(sig);
      if (!coach) return;

      setState(s => ({ ...s, coaching: coach }));

      // Disappearing text: clear the coaching after the visible window unless
      // something newer has replaced it in the meantime.
      if (r.coachClearTo) clearTimeout(r.coachClearTo);
      r.coachClearTo = setTimeout(() => {
        setState(s => {
          if (s.coaching && s.coaching.id === coach.id) {
            return { ...s, coaching: null };
          }
          return s;
        });
      }, COACHING_VISIBLE_MS);
    }, 1000);

    const tick = () => {
      if (!r.active) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length) || 1e-9;
      const dbfs = 20 * Math.log10(rms);
      const level = levelFromDb(dbfs);
      const elapsed = (performance.now() - r.startTs) / 1000;
      if (elapsed > 0) r.volumeTimeline.push({ t: +elapsed.toFixed(3), dbfs: +dbfs.toFixed(2) });
      r.currentLevel = level;

      setState(s => {
        const wpm = calcWpm(s.transcript, elapsed) || s.wpm || 0;
        const pace = wpmToPace(wpm || 160);
        r.currentWpm = wpm;
        return { ...s, level, elapsed, wpm, pace };
      });

      if (elapsed >= (window.TRAINING_MAX || 180) && r.onMaxDuration) {
        r.onMaxDuration();
        return;
      }
      r.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function teardown(r, options = {}) {
    const { upload = true, navigate = true } = options;

    try {
      if (r.raf) cancelAnimationFrame(r.raf);
      if (r.coachInterval) clearInterval(r.coachInterval);
      if (r.coachTick) clearInterval(r.coachTick);
      if (r.coachClearTo) clearTimeout(r.coachClearTo);
    } catch {}

    // stop recorder + wait for final chunk
    const recorderMime = r.recorder ? (r.recorder.mimeType || 'video/webm') : 'video/webm';
    if (r.recorder && r.recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        r.recorder.addEventListener('stop', resolve, { once: true });
        try { r.recorder.stop(); } catch { resolve(); }
      });
    }

    // tell server to stop, give it a beat to persist files
    if (r.ws && r.ws.readyState === WebSocket.OPEN) {
      try { r.ws.send(JSON.stringify({ type: 'stop' })); } catch {}
      await new Promise(res => setTimeout(res, 700));
      try { r.ws.close(); } catch {}
    }
    if (r.coachWs) { try { r.coachWs.close(); } catch {} }
    if (r.worklet) { try { r.worklet.disconnect(); } catch {} }
    if (r.audioCtx) { try { await r.audioCtx.close(); } catch {} }
    if (r.media) r.media.getTracks().forEach(t => t.stop());

    const elapsed = r.startTs ? (performance.now() - r.startTs) / 1000 : 0;
    const minDuration = window.TRAINING_MIN || 10;

    if (!upload) return;
    if (!r.sessionId) {
      showError('No session id — nothing to save.');
      return;
    }
    if (elapsed < minDuration) {
      showError(`Too short. Record for at least ${minDuration}s.`);
      return;
    }
    if (!r.chunks.length) {
      showError('No video data captured.');
      return;
    }

    dbg('uploading session=' + r.sessionId + ' chunks=' + r.chunks.length + ' elapsed=' + elapsed.toFixed(1));
    const blob = new Blob(r.chunks, { type: recorderMime });
    const form = new FormData();
    form.append('video', blob, 'video.webm');
    form.append('audio', blob, 'audio.webm');
    form.append('volume', JSON.stringify(r.volumeTimeline || []));
    form.append('transcript_hint', r.finalTranscriptText || '');
    form.append('session_id', r.sessionId);

    try {
      const resp = await fetch('/train/submit', { method: 'POST', body: form });
      if (!resp.ok) throw new Error('upload failed: HTTP ' + resp.status);
      const data = await resp.json();
      dbg('upload ok, redirecting to /review/' + data.session_id);
      if (navigate) location.href = `/review/${data.session_id}`;
    } catch (err) {
      showError('Upload failed: ' + (err.message || err));
    }
  }

  // ─── the hook that replaces useStream from stream.jsx ────────────────────

  const INITIAL_STATE = {
    level: 0,
    pace: 0.5,
    wpm: 0,
    emotion: 'neutral',
    fillers: 0,
    transcript: '',
    partial: '',
    coaching: null,
    biomarkers: { jitter: 1.8, shimmer: 0.19, hnr: 14 },
    signals: {},
    elapsed: 0,
  };

  // How long a coaching phrase stays on screen before it fades out.
  const COACHING_VISIBLE_MS = 5200;

  function useLiveStream({ playing }) {
    const [state, setState] = React.useState(INITIAL_STATE);
    const refsRef = React.useRef({ everStarted: false });

    React.useEffect(() => {
      if (!playing) return undefined;

      clearError();

      const r = {
        active: true,
        chunks: [],
        volumeTimeline: [],
        finalTranscriptText: '',
        sessionId: null,
      };
      refsRef.current = Object.assign(refsRef.current, r);
      refsRef.current.active = true;
      refsRef.current.everStarted = true;

      setState({ ...INITIAL_STATE });

      const initPromise = startPipeline(refsRef.current, setState).catch((err) => {
        showError('Start failed: ' + (err.message || err.name || String(err)));
        refsRef.current.active = false;
        refsRef.current.failedToStart = true;
      });

      // When max duration hits, trigger the same teardown + upload flow.
      refsRef.current.onMaxDuration = () => {
        refsRef.current.active = false;
        initPromise.then(() => {
          if (refsRef.current.teardownDone) return;
          refsRef.current.teardownDone = true;
          return teardown(refsRef.current, { upload: true, navigate: true });
        });
      };

      return () => {
        const ref = refsRef.current;
        ref.active = false;
        // Wait for init to finish before tearing down, to avoid half-built state.
        initPromise.then(() => {
          if (ref.teardownDone) return;
          ref.teardownDone = true;
          return teardown(ref, { upload: !ref.failedToStart, navigate: !ref.failedToStart });
        }).catch((err) => dbg('teardown failed: ' + (err.message || err)));
      };
    }, [playing]);

    return state;
  }

  // Override the mock stream hook from /ui/stream.jsx (we don't include that
  // script). TrainScreen looks up `useStream` on window at render time.
  window.useStream = (opts) => useLiveStream({ playing: !!(opts && opts.playing) });

  // ─── App ──────────────────────────────────────────────────────────────

  function App() {
    const [scenario, setScenario] = React.useState('pitch');
    const [playing, setPlaying] = React.useState(false);

    // Expose a keyboard shortcut so demo audience can quick-end the session.
    React.useEffect(() => {
      const onKey = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === '.') {
          e.preventDefault();
          setPlaying(false);
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);

    return <TrainScreen
      scenario={scenario}
      setScenario={setScenario}
      playing={playing}
      setPlaying={setPlaying}
    />;
  }

  function mount() {
    if (!window.TrainScreen) {
      // Babel hasn't finished transforming train-screen.jsx yet; retry.
      return setTimeout(mount, 50);
    }
    if ($scrim) $scrim.classList.add('hidden');
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
    dbg('mounted');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(mount, 0);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 0));
  }
})();
