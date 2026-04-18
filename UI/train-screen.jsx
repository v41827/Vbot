// TrainScreen — the /train laptop surface.
// Layout: left sidebar (session meta) | center stage (orb + transcript + coaching) | right insights
// The orb is the focal point. Transcript streams below it. Coaching flashes above.

function TrainScreen({ scenario = 'standup', setScenario, playing = true, setPlaying }) {
  const stream = useStream({ playing, scenario });
  const [session] = React.useState({
    startedAt: Date.now(),
    targetDuration: 120,
  });

  const fmtTime = (s) => {
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${String(m).padStart(1, '0')}:${String(r).padStart(2, '0')}`;
  };

  // Orb state from stream
  const orbState =
    stream.emotion === 'anxious' ? 'alert'
    : stream.emotion === 'calm' ? 'calm'
    : 'listening';

  const scenarios = [
    { id: 'standup',   label: 'Daily standup',   sub: '2 min' },
    { id: 'interview', label: 'Tech interview',  sub: '5 min' },
    { id: 'pitch',     label: 'Investor pitch',  sub: '3 min' },
  ];

  return (
    <div style={{
      width: '100%', height: '100%', background: T.cream,
      fontFamily: T.sans, color: T.ink,
      display: 'grid',
      gridTemplateColumns: '280px 1fr 340px',
      gridTemplateRows: '72px 1fr',
    }}>
      {/* ─── top bar ─── */}
      <div style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', borderBottom: `1px solid ${T.line}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Logo />
          <div style={{ width: 1, height: 20, background: T.line }} />
          <span style={{ fontSize: 14, color: T.inkSoft }}>Training</span>
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.4 }}>
            <path d="M3 2l3 3-3 3" stroke={T.ink} strokeWidth="1.5" fill="none" strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: 14, color: T.ink, fontWeight: 500 }}>
            {scenarios.find(s => s.id === scenario)?.label}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Pill tone="good" size="md">
            <span style={{
              width: 7, height: 7, borderRadius: 999, background: T.forest,
              animation: 'pulse 1.4s ease-in-out infinite',
            }} />
            Buzz connected
          </Pill>
          <Pill tone="ghost" size="md">
            <span style={{ fontFamily: T.mono, fontSize: 12 }}>⌘ .</span>
            End session
          </Pill>
          <div style={{
            width: 32, height: 32, borderRadius: 999, background: T.terracotta,
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 600,
          }}>M</div>
        </div>
      </div>

      {/* ─── left sidebar ─── */}
      <div style={{
        padding: '32px 24px', borderRight: `1px solid ${T.line}`,
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.inkMuted,
            textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 14,
          }}>Scenario</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {scenarios.map(s => (
              <button key={s.id}
                onClick={() => setScenario?.(s.id)}
                style={{
                  textAlign: 'left', padding: '14px 16px',
                  background: scenario === s.id ? T.ink : 'transparent',
                  color: scenario === s.id ? T.cream : T.ink,
                  border: `1px solid ${scenario === s.id ? T.ink : T.line}`,
                  borderRadius: T.rMd, cursor: 'pointer',
                  fontFamily: T.sans, fontSize: 14, fontWeight: 500,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  transition: 'all 120ms',
                }}>
                <span>{s.label}</span>
                <span style={{ fontSize: 12, opacity: 0.55 }}>{s.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ height: 1, background: T.line }} />

        <div>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.inkMuted,
            textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 14,
          }}>Goals this session</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { label: 'Fewer fillers', status: 'active' },
              { label: 'Slower pace', status: 'active' },
              { label: 'Hold pauses', status: 'idle' },
            ].map(g => (
              <div key={g.label} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                fontSize: 14, color: g.status === 'active' ? T.ink : T.inkMuted,
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: 999,
                  border: `1.5px solid ${g.status === 'active' ? T.terracotta : T.lineStrong}`,
                  background: g.status === 'active' ? T.terracotta : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {g.status === 'active' && (
                    <svg width="8" height="8" viewBox="0 0 8 8">
                      <path d="M1 4l2 2 4-4" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                {g.label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 'auto' }}>
          <Card pad={18} radius={T.rMd} tint={T.paperDeep} style={{ border: 'none' }}>
            <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 6, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: T.ink }}>Tip.</span> Your Buzz will tap once for pace, twice for volume.
            </div>
          </Card>
        </div>
      </div>

      {/* ─── center stage ─── */}
      <div style={{
        padding: '40px 48px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', position: 'relative', overflow: 'hidden',
      }}>
        {/* Coaching line — floats above orb */}
        <div style={{
          height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%',
        }}>
          {stream.coaching ? (
            <div key={stream.coaching.id} style={{
              padding: '14px 24px', borderRadius: 9999,
              background: stream.coaching.kind === 'good' ? T.forestSoft
                : stream.coaching.kind === 'alert' ? T.roseSoft
                : stream.coaching.kind === 'warn' ? T.amberSoft
                : T.terracottaSoft,
              color: stream.coaching.kind === 'good' ? T.forest
                : stream.coaching.kind === 'alert' ? '#8A3B3B'
                : stream.coaching.kind === 'warn' ? '#8A6120'
                : T.terracottaDeep,
              fontSize: 18, fontFamily: T.display, letterSpacing: -0.3,
              animation: 'coachIn 360ms cubic-bezier(.2,.7,.2,1), coachOut 500ms ease 4500ms forwards',
              boxShadow: T.shadowSm,
            }}>
              <KineticText text={stream.coaching.text} />
            </div>
          ) : (
            <div style={{
              fontSize: 14, color: T.inkFaint, fontStyle: 'italic',
              fontFamily: T.display,
            }}>Listening…</div>
          )}
        </div>

        {/* Orb */}
        <div style={{ marginTop: 12, marginBottom: 32, position: 'relative' }}>
          <Orb level={stream.level} pace={stream.pace} state={orbState} size={300} />
        </div>

        {/* Transcript block */}
        <div style={{
          width: '100%', maxWidth: 640,
          fontFamily: T.display, fontSize: 28, lineHeight: 1.45,
          letterSpacing: -0.3, color: T.ink,
          textAlign: 'center', minHeight: 140,
        }}>
          <span style={{ color: T.inkMuted }}>{stream.transcript} </span>
          <span style={{
            color: T.ink, borderBottom: `2px solid ${T.terracotta}`,
            paddingBottom: 2,
          }}>
            {stream.partial}
            {stream.partial && <span style={{
              display: 'inline-block', width: 2, height: 24,
              background: T.terracotta, marginLeft: 2, verticalAlign: 'middle',
              animation: 'caret 1s step-end infinite',
            }} />}
          </span>
        </div>

        {/* Bottom control row */}
        <div style={{
          marginTop: 'auto', paddingTop: 32,
          display: 'flex', alignItems: 'center', gap: 20,
        }}>
          <button onClick={() => setPlaying?.(p => !p)} style={{
            width: 64, height: 64, borderRadius: 999,
            background: T.ink, color: T.cream, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: T.shadowMd,
          }}>
            {playing ? (
              <svg width="18" height="20" viewBox="0 0 18 20">
                <rect x="2" y="2" width="4" height="16" rx="1" fill={T.cream}/>
                <rect x="12" y="2" width="4" height="16" rx="1" fill={T.cream}/>
              </svg>
            ) : (
              <svg width="18" height="20" viewBox="0 0 18 20">
                <path d="M3 2l13 8-13 8V2z" fill={T.cream}/>
              </svg>
            )}
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontFamily: T.mono, fontSize: 16, color: T.ink }}>
              {fmtTime(stream.elapsed)} <span style={{ color: T.inkMuted }}>/ 2:00</span>
            </div>
            <div style={{ fontSize: 12, color: T.inkMuted }}>
              {playing ? 'Recording' : 'Paused'} · {stream.fillers} filler{stream.fillers === 1 ? '' : 's'}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Waveform level={stream.level} bars={36} color={T.inkSoft} height={48} />
          </div>
        </div>
      </div>

      {/* ─── right insights ─── */}
      <div style={{
        padding: '32px 28px', borderLeft: `1px solid ${T.line}`,
        display: 'flex', flexDirection: 'column', gap: 24, overflow: 'auto',
      }}>
        <PaceMeter pace={stream.pace} wpm={stream.wpm} />

        <Card pad={22} radius={T.rMd}>
          <div style={{
            fontSize: 12, fontWeight: 500, color: T.inkMuted,
            textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16,
          }}>Volume</div>
          <Waveform level={stream.level} bars={32} color={T.terracotta} height={56} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 11, color: T.inkMuted, fontFamily: T.mono }}>
            <span>-60 dB</span>
            <span>{(-60 + stream.level * 48).toFixed(0)} dB</span>
            <span>0 dB</span>
          </div>
        </Card>

        <Card pad={22} radius={T.rMd}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
            <div style={{
              fontSize: 12, fontWeight: 500, color: T.inkMuted,
              textTransform: 'uppercase', letterSpacing: 1,
            }}>Emotion</div>
            <Pill tone={stream.emotion === 'calm' ? 'good' : stream.emotion === 'anxious' ? 'alert' : 'neutral'} size="sm">
              {stream.emotion}
            </Pill>
          </div>
          <EmotionRadar emotion={stream.emotion} level={stream.level} pace={stream.pace} />
        </Card>

        <Card pad={22} radius={T.rMd} tint={T.paperDeep} style={{ border: 'none' }}>
          <div style={{
            fontSize: 12, fontWeight: 500, color: T.inkMuted,
            textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14,
          }}>Live biomarkers</div>
          <SignalBars signals={stream.signals || {}} />
        </Card>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes caret { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
        @keyframes coachIn {
          0% { opacity: 0; transform: translateY(-10px) scale(0.95); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes coachOut {
          0% { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(6px) scale(0.98); }
        }
      `}</style>
    </div>
  );
}

function MiniStat({ label, value, unit }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: T.display, fontSize: 22, color: T.ink, letterSpacing: -0.3, lineHeight: 1 }}>
        {value}<span style={{ fontSize: 11, color: T.inkMuted, fontFamily: T.sans, marginLeft: 2 }}>{unit}</span>
      </div>
    </div>
  );
}

// Live signal bars — driven by the raw Thymia policy scores exposed on the
// stream state. "positive" bars go green→red as the number falls; "negative"
// bars go green→red as the number rises. Missing values render as 0.
function SignalBars({ signals }) {
  const rows = [
    { key: 'distress',   label: 'Distress',   polarity: 'negative' },
    { key: 'confidence', label: 'Confidence', polarity: 'positive' },
    { key: 'fatigue',    label: 'Fatigue',    polarity: 'negative' },
    { key: 'engagement', label: 'Engagement', polarity: 'positive' },
  ];
  const pick = (key, alt) => {
    if (!signals || typeof signals !== 'object') return null;
    for (const k of [key, ...(alt || [])]) {
      const v = signals[k];
      if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.min(1, v));
    }
    return null;
  };
  const synonyms = {
    distress:   ['anxiety', 'stress', 'tension'],
    confidence: ['assurance', 'certainty'],
    fatigue:    ['tiredness'],
    engagement: ['energy', 'presence', 'focus'],
  };
  const barColor = (v, polarity) => {
    if (polarity === 'negative') {
      if (v < 0.34) return T.forest;
      if (v < 0.67) return T.amber;
      return T.terracotta;
    } else {
      if (v < 0.34) return T.terracotta;
      if (v < 0.67) return T.amber;
      return T.forest;
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((r) => {
        const v = pick(r.key, synonyms[r.key]);
        const pct = v == null ? 0 : Math.round(v * 100);
        const col = v == null ? T.inkFaint : barColor(v, r.polarity);
        return (
          <div key={r.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: T.inkSoft, fontWeight: 500 }}>{r.label}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: v == null ? T.inkFaint : T.inkSoft }}>
                {v == null ? '—' : pct + '%'}
              </span>
            </div>
            <div style={{
              height: 6, borderRadius: 999, background: 'rgba(20,20,19,0.08)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: pct + '%',
                background: col, borderRadius: 999,
                transition: 'width 280ms ease, background 200ms ease',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8,
        background: T.ink, color: T.cream,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: T.display, fontSize: 18, lineHeight: 1,
      }}>b</div>
      <span style={{
        fontFamily: T.display, fontSize: 20, letterSpacing: -0.3, color: T.ink,
      }}>buzzline</span>
    </div>
  );
}

// Mini emotion radar — four axes: calm, confident, present, warmth
function EmotionRadar({ emotion, level, pace }) {
  // Map to rough axis values (0..1)
  const axes = {
    calm:     emotion === 'calm' ? 0.85 : emotion === 'anxious' ? 0.3 : 0.6,
    confidence: Math.min(1, 0.4 + level * 0.6),
    presence: emotion === 'flat' ? 0.3 : 0.7,
    warmth:   0.5 + (pace < 0.6 ? 0.2 : -0.1),
  };
  const size = 160;
  const cx = size / 2, cy = size / 2, R = size * 0.38;
  const keys = Object.keys(axes);
  const angle = (i) => -Math.PI / 2 + (i / keys.length) * Math.PI * 2;
  const pt = (i, v) => [cx + Math.cos(angle(i)) * R * v, cy + Math.sin(angle(i)) * R * v];
  const polyPts = keys.map((k, i) => pt(i, axes[k]).join(',')).join(' ');
  const labelPt = (i) => [cx + Math.cos(angle(i)) * (R + 14), cy + Math.sin(angle(i)) * (R + 14)];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', margin: '0 auto' }}>
      {[0.33, 0.66, 1].map(s => (
        <polygon key={s}
          points={keys.map((_, i) => pt(i, s).join(',')).join(' ')}
          fill="none" stroke={T.line} strokeWidth={1}
        />
      ))}
      {keys.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={T.line} strokeWidth={1} />;
      })}
      <polygon points={polyPts} fill={T.terracotta} fillOpacity={0.22} stroke={T.terracotta} strokeWidth={1.5} />
      {keys.map((k, i) => {
        const [x, y] = labelPt(i);
        return (
          <text key={k} x={x} y={y} fill={T.inkMuted}
            fontSize="10" textAnchor="middle" dominantBaseline="middle"
            fontFamily={T.sans} letterSpacing={0.3}>
            {k}
          </text>
        );
      })}
    </svg>
  );
}

Object.assign(window, { TrainScreen });
