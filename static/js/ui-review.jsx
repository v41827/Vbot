/* ui-review.jsx — polls /session/{id} until ready, then renders ReviewScreen
 * with real data mapped onto the UI's props.
 */

(() => {
  const $loading = document.getElementById('review-loading');
  const $error = document.getElementById('review-error');
  const $errorDetail = document.getElementById('review-error-detail');

  const sessionId = window.SESSION_ID;

  function showError(text) {
    if ($loading) $loading.classList.add('hidden');
    if ($error) { $error.classList.add('show'); }
    if ($errorDetail) $errorDetail.textContent = text || '';
  }

  async function poll() {
    for (let i = 0; i < 80; i++) {
      let data;
      try {
        const r = await fetch(`/session/${sessionId}`, { cache: 'no-store' });
        data = await r.json();
      } catch (err) {
        await sleep(2000);
        continue;
      }
      const s = data && data.status && data.status.status;
      if (s === 'ready' && data.report) return data.report;
      if (s === 'failed') {
        showError((data.status && data.status.error) || 'Unknown processing error');
        return null;
      }
      await sleep(1500);
    }
    showError('Timed out waiting for analysis.');
    return null;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ─── transforms ─────────────────────────────────────────────────────────

  function fmtMMSS(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function groupWordsToChunks(words, opts = {}) {
    const { maxSec = 5, maxWords = 12, pauseSec = 0.6 } = opts;
    const chunks = [];
    let cur = null;
    for (const w of words) {
      const startWord = String(w.text || '').trim();
      if (!startWord) continue;
      if (!cur) {
        cur = { t: w.start || 0, words: [w], endT: w.end || w.start || 0 };
        continue;
      }
      const gap = (w.start || 0) - (cur.endT || 0);
      const spanSec = (w.end || w.start || 0) - cur.t;
      if (gap > pauseSec || spanSec > maxSec || cur.words.length >= maxWords) {
        chunks.push(finalizeChunk(cur));
        cur = { t: w.start || 0, words: [w], endT: w.end || w.start || 0 };
      } else {
        cur.words.push(w);
        cur.endT = w.end || w.start || cur.endT;
      }
    }
    if (cur) chunks.push(finalizeChunk(cur));
    return chunks;
  }

  function finalizeChunk(c) {
    const text = c.words.map(w => w.text || '').join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    const flags = [];
    if (/\b(um+|uh+|erm+)\b/i.test(text)) flags.push('filler');
    if (c.words.length <= 2) flags.push('short');
    return { t: c.t, text, flags };
  }

  function fillerMarkersFromWords(words, duration) {
    if (!words || !words.length || !duration) return [];
    const markers = [];
    for (const w of words) {
      if (/^(um+|uh+|erm+)[,.!?]?$/i.test(String(w.text || '').trim())) {
        const t = w.start || 0;
        if (duration > 0) markers.push(+(t / duration).toFixed(4));
      }
    }
    return markers.slice(0, 24);
  }

  function heroLines(report) {
    const r = report.report || {};
    const emo = (report.emotion && report.emotion.dominant) || '';
    const fillers = Math.round(((report.biomarker && report.biomarker.filler_rate) || 0) * countWords(report));
    const biomPace = (report.biomarker && report.biomarker.pace_wpm) || 0;
    if (r.summary) {
      const [first, ...rest] = r.summary.split(/(?<=[.!?])\s+/);
      return {
        l1: first || 'Session complete.',
        l2: rest.join(' ') || `${fillers || 'Zero'} fillers · ${biomPace ? Math.round(biomPace) + ' wpm' : 'ready to review'}.`,
      };
    }
    const toneLine = emo === 'calm' ? 'Calm delivery.'
      : emo === 'anxious' ? 'A little tense.'
      : emo === 'sad' ? 'A little flat.'
      : emo === 'excited' ? 'Lively delivery.'
      : 'Session complete.';
    const sub = fillers
      ? `${fillers} filler${fillers === 1 ? '' : 's'} · ${biomPace ? Math.round(biomPace) + ' wpm' : 'ready to review'}.`
      : 'Smooth all the way through.';
    return { l1: toneLine, l2: sub };
  }

  function countWords(report) {
    const t = (report.transcript && (report.transcript.text || '')) || '';
    return t.trim().split(/\s+/).filter(Boolean).length || 1;
  }

  function deriveScore(report) {
    const r = report.report || {};
    if (typeof r.score === 'number') return r.score;
    if (typeof r.score === 'string' && /^\d+/.test(r.score)) return parseInt(r.score, 10);
    // fallback: derive a rough score from filler_rate + pace proximity
    const fillerRate = (report.biomarker && report.biomarker.filler_rate) || 0;
    const pace = (report.biomarker && report.biomarker.pace_wpm) || 160;
    const paceScore = Math.max(0, 100 - Math.abs(pace - 160) * 1.1);
    const fillerScore = Math.max(0, 100 - fillerRate * 600);
    return Math.round((paceScore + fillerScore) / 2);
  }

  function paceTimelineFromWords(words, totalDur) {
    if (!words || words.length < 6 || !totalDur || totalDur < 2) return null;
    const windowSec = 10;
    const step = Math.max(5, Math.floor(totalDur / 14));
    const series = [];
    for (let t = 0; t + step <= totalDur; t += step) {
      const start = t, end = t + windowSec;
      const inWindow = words.filter(w => (w.start || 0) >= start && (w.start || 0) < end).length;
      const wpm = Math.round((inWindow / Math.max(1, (end - start))) * 60);
      series.push(wpm);
    }
    if (series.length < 3) return null;
    return series;
  }

  function classifyAvgPace(wpm) {
    if (!wpm) return { label: 'No data', tone: 'ink' };
    if (wpm < 130) return { label: 'A touch slow', tone: 'warn' };
    if (wpm > 190) return { label: 'Too fast', tone: 'warn' };
    if (wpm >= 140 && wpm <= 180) return { label: 'In target zone', tone: 'good' };
    return { label: 'Close to target', tone: 'good' };
  }

  function fillersBreakdown(words) {
    const counts = { um: 0, uh: 0, erm: 0 };
    for (const w of (words || [])) {
      const t = String(w.text || '').trim().toLowerCase().replace(/[,.!?]$/, '');
      if (/^um+$/.test(t)) counts.um++;
      else if (/^uh+$/.test(t)) counts.uh++;
      else if (/^erm+$/.test(t)) counts.erm++;
    }
    const parts = [];
    if (counts.um) parts.push(`${counts.um} × "um"`);
    if (counts.uh) parts.push(`${counts.uh} × "uh"`);
    if (counts.erm) parts.push(`${counts.erm} × "erm"`);
    return parts.length ? parts.join(', ') : 'none detected';
  }

  function avgVolumeLabel(volumeTimeline) {
    if (!volumeTimeline || !volumeTimeline.length) return { value: '—', label: 'No data' };
    const dbfsValues = volumeTimeline
      .map(p => p.dbfs)
      .filter(v => typeof v === 'number' && isFinite(v) && v > -120 && v < 10);
    if (!dbfsValues.length) return { value: '—', label: 'No data' };
    const avg = dbfsValues.reduce((a, b) => a + b, 0) / dbfsValues.length;
    const shown = Math.round(avg);
    const signStr = shown < 0 ? `−${Math.abs(shown)}` : `${shown}`;
    const label = avg < -40 ? 'A bit quiet' : avg > -12 ? 'On the loud side' : 'Steady';
    return { value: signStr, label };
  }

  function avgPauseFromWords(words) {
    if (!words || words.length < 2) return { value: '—', label: 'No data' };
    const pauses = [];
    for (let i = 1; i < words.length; i++) {
      const gap = (words[i].start || 0) - (words[i - 1].end || words[i - 1].start || 0);
      if (gap > 0.15 && gap < 4) pauses.push(gap);
    }
    if (!pauses.length) return { value: '—', label: 'No clear pauses' };
    const avg = pauses.reduce((a, b) => a + b, 0) / pauses.length;
    return {
      value: avg.toFixed(1),
      label: avg > 0.7 ? 'Comfortable cadence' : 'Quick between thoughts',
    };
  }

  function breadcrumbFromSessionId(id) {
    // sessions/20260418-171908-0b81fb -> "Session · Apr 18, 17:19"
    if (!id) return 'Session';
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
    if (!m) return 'Session';
    const [, y, mo, d, hh, mm] = m;
    const date = new Date(+y, +mo - 1, +d, +hh, +mm);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Session · ${months[date.getMonth()]} ${date.getDate()}, ${String(hh).padStart(2, '0')}:${mm}`;
  }

  function buildData(report) {
    const duration = report.duration_seconds || 0;
    const words = (report.transcript && report.transcript.words) || [];
    let chunks = groupWordsToChunks(words);
    // Fallback: if there are no word-level timestamps but we have raw text,
    // surface it as one chunk so the user sees SOMETHING instead of the
    // hardcoded placeholder transcript.
    if (!chunks.length) {
      const rawText = (report.transcript && report.transcript.text) || '';
      if (rawText.trim()) {
        chunks = [{ t: 0, text: rawText.trim() }];
      } else {
        chunks = [{ t: 0, text: '(no transcript captured — check your Speechmatics key)' }];
      }
    }
    const fillerMarks = fillerMarkersFromWords(words, duration);

    const biom = report.biomarker || {};
    const rawPace = biom.pace_wpm;
    const avgPace = rawPace ? Math.round(rawPace) : '—';
    const paceClass = classifyAvgPace(rawPace);

    const fillerRate = biom.filler_rate || 0;
    const totalWordCount = countWords(report);
    const fillersCount = Math.round(fillerRate * totalWordCount);

    const pause = avgPauseFromWords(words);
    const vol = avgVolumeLabel(report.volume_timeline || []);

    const report_r = report.report || {};
    let tips = (report_r.tips || []).map((t, i) => ({
      n: String(i + 1),
      text: t.text || String(t),
    })).slice(0, 3);
    while (tips.length < 3) tips = null; // if we don't have 3, fall back to defaults
    // Actually: if fewer than 3, still show what we have
    tips = (report_r.tips || []).map((t, i) => ({
      n: String(i + 1),
      text: t.text || String(t),
    })).slice(0, 3);
    if (!tips.length) tips = undefined;

    const hero = heroLines(report);
    const score = deriveScore(report);

    const videoSrc = report.video_file
      ? `/session/${sessionId}/media/${report.video_file}`
      : report.audio_file ? `/session/${sessionId}/media/${report.audio_file}` : null;

    return {
      duration: duration || 60,
      breadcrumb: breadcrumbFromSessionId(sessionId),
      sessionLabel: duration
        ? `Session · ${Math.floor(duration / 60)} min ${String(Math.round(duration % 60)).padStart(2, '0')}`
        : 'Session',
      heroLine1: hero.l1,
      heroLine2: hero.l2,
      videoSrc,
      transcriptChunks: chunks,
      score,
      scoreTrend: null,
      avgPace,
      avgPaceLabel: paceClass.label,
      avgPaceTone: paceClass.tone,
      fillers: fillersCount,
      fillersLabel: fillersBreakdown(words),
      avgPause: pause.value,
      avgPauseLabel: pause.label,
      avgVolume: vol.value,
      avgVolumeLabel: vol.label,
      fillerMarkers: fillerMarks.length ? fillerMarks : undefined,
      paceSeries: paceTimelineFromWords(words, duration) || undefined,
      tips,
    };
  }

  // ─── mount ────────────────────────────────────────────────────────────

  function App({ data }) {
    return <ReviewScreen data={data} />;
  }

  async function main() {
    if (!window.ReviewScreen) {
      return setTimeout(main, 60);
    }
    const report = await poll();
    if (!report) return;

    const data = buildData(report);
    if ($loading) $loading.classList.add('hidden');

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App data={data} />);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(main, 0);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(main, 0));
  }
})();
