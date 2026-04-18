// Streaming simulator — fake live data for the prototype.
// Produces dBFS, pace (WPM), emotion, transcript tokens, coaching lines.
// Scripted so the user sees an interesting arc: starts nervous, gets calm.

function useStream({ playing = true, scenario = 'standup' }) {
  const [state, setState] = React.useState({
    level: 0.25,        // 0..1 (dBFS normalized)
    pace: 0.55,         // 0..1 (WPM normalized; 0.5 = target)
    wpm: 165,
    emotion: 'neutral', // 'calm'|'neutral'|'anxious'|'flat'
    fillers: 0,
    transcript: '',     // live finalizing text
    partial: '',        // currently building utterance
    coaching: null,     // { id, text, kind }
    biomarkers: { jitter: 1.8, shimmer: 0.19, hnr: 14 },
    elapsed: 0,         // seconds
  });

  const tickRef = React.useRef(0);
  const scriptRef = React.useRef(null);

  // Scenario-specific script
  const scripts = {
    standup: [
      { t: 0,   partial: 'so' },
      { t: 0.8, partial: 'so um,' },
      { t: 1.5, partial: 'so um, yesterday I' },
      { t: 2.5, partial: 'so um, yesterday I shipped the' },
      { t: 3.5, partial: 'so um, yesterday I shipped the pricing page—' },
      { t: 4.2, finalize: 'So um, yesterday I shipped the pricing page.', fillers: 1 },
      { t: 4.5, coach: { text: 'Breathe. You have time.', kind: 'calm' } },
      { t: 6,   partial: 'today I' },
      { t: 7,   partial: "today I'm picking up" },
      { t: 8.2, partial: "today I'm picking up the onboarding flow" },
      { t: 9.5, finalize: "Today I'm picking up the onboarding flow." },
      { t: 10,  coach: { text: 'Nice — slower cadence.', kind: 'good' } },
      { t: 11,  partial: 'no blockers' },
      { t: 12,  finalize: 'No blockers.' },
    ],
    interview: [
      { t: 0,   partial: 'yeah so' },
      { t: 1,   partial: 'yeah so like, my background is' },
      { t: 2.2, partial: 'yeah so like, my background is mostly backend—' },
      { t: 3,   finalize: 'Yeah, so, like, my background is mostly backend.', fillers: 2 },
      { t: 3.5, coach: { text: 'Drop the "like." Land your words.', kind: 'warn' } },
      { t: 5,   partial: 'I worked at Stripe for three years' },
      { t: 7,   finalize: 'I worked at Stripe for three years.' },
      { t: 8,   coach: { text: 'Much better. Keep that pace.', kind: 'good' } },
    ],
    pitch: [
      { t: 0,   partial: 'we are' },
      { t: 1,   partial: 'we are building the' },
      { t: 2,   partial: 'we are building the first' },
      { t: 3,   partial: 'we are building the first speech coach that' },
      { t: 4.5, partial: 'we are building the first speech coach that listens in real time' },
      { t: 6,   finalize: 'We are building the first speech coach that listens in real time.' },
      { t: 6.3, coach: { text: 'Strong open. Pause here.', kind: 'good' } },
      { t: 8.5, partial: 'and buzzes your wrist when you' },
      { t: 10,  finalize: 'And buzzes your wrist when you drift.' },
    ],
  };

  React.useEffect(() => {
    if (!playing) return;
    // reset on scenario change
    scriptRef.current = { script: scripts[scenario] || scripts.standup, idx: 0, startTick: tickRef.current };
    setState(s => ({ ...s, transcript: '', partial: '', fillers: 0, coaching: null, elapsed: 0 }));
  }, [scenario, playing]);

  React.useEffect(() => {
    if (!playing) return;
    let raf;
    const loop = () => {
      tickRef.current += 1;
      const t = tickRef.current;

      // Pseudo-random audio-ish envelope
      const noise = (Math.sin(t * 0.09) + Math.sin(t * 0.17) * 0.6 + Math.sin(t * 0.31) * 0.4) / 2;
      const baseLevel = 0.45 + noise * 0.35;
      const levelJitter = (Math.random() - 0.5) * 0.2;
      const level = Math.max(0.05, Math.min(1, baseLevel + levelJitter));

      // Pace drifts around target; scenario-dependent
      const targetPace = scenario === 'interview' ? 0.72 : scenario === 'pitch' ? 0.48 : 0.6;
      const pace = targetPace + Math.sin(t * 0.04) * 0.12;
      const wpm = Math.round(140 + pace * 80);

      // Script timeline
      const s = scriptRef.current;
      const elapsed = (t - s.startTick) / 60; // ~60fps

      let update = { level, pace, wpm, elapsed };

      while (s.idx < s.script.length && s.script[s.idx].t <= elapsed) {
        const step = s.script[s.idx];
        if (step.partial !== undefined) update.partial = step.partial;
        if (step.finalize) {
          update.transcript = (state.transcript + ' ' + step.finalize).trim();
          update.partial = '';
          if (step.fillers) update.fillers = (state.fillers || 0) + step.fillers;
        }
        if (step.coach) update.coaching = { ...step.coach, id: t };
        s.idx += 1;
      }

      // Emotion derived from level variance + pace
      let emotion = 'neutral';
      if (pace > 0.75 && level > 0.6) emotion = 'anxious';
      else if (pace < 0.45 && level < 0.4) emotion = 'flat';
      else if (pace > 0.5 && pace < 0.65) emotion = 'calm';

      update.emotion = emotion;

      setState(prev => ({ ...prev, ...update, transcript: update.transcript ?? prev.transcript }));

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scenario]);

  return state;
}

Object.assign(window, { useStream });
