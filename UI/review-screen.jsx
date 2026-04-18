// ReviewScreen — post-session recap.
// Video+transcript hero, charts flank, V-Bot tips at bottom.
// Static (not streaming) — this is playback.
//
// Accepts an optional `data` prop so the same UI can be driven by a real
// session report. All fields are optional; sensible hardcoded defaults are
// used whenever a field is missing so the original Buzzline.html render still
// works.

function ReviewScreen({ data } = {}) {
  const d = data || {};
  const videoRef = React.useRef(null);
  const [scrub, setScrub] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);

  const duration = d.duration || 124;

  const fmtTime = (s) => {
    s = Math.max(0, Math.min(duration, s || 0));
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  const breadcrumb = d.breadcrumb || 'Standup · today 9:14 AM';
  const sessionLabel =
    d.sessionLabel ||
    (d.duration != null
      ? `Session · ${Math.floor(duration / 60)} min ${String(Math.round(duration % 60)).padStart(2, '0')}`
      : 'Session · 2 min 04');
  const heroLine1 = d.heroLine1 || 'Calmer than yesterday.';
  const heroLine2 = d.heroLine2 || 'Still three "ums."';
  const videoSrc = d.videoSrc || null;

  const transcriptChunks = d.transcriptChunks || [
    { t: 0,   speaker: 'you', text: 'So, um, yesterday I shipped the pricing page.', flags: ['filler'] },
    { t: 6,   speaker: 'you', text: "Today I'm picking up the onboarding flow." },
    { t: 12,  speaker: 'you', text: 'No blockers.', flags: ['short'] },
    { t: 15,  speaker: 'you', text: 'Uh, I also paired with Ravi on the rate limiter—', flags: ['filler'] },
    { t: 22,  speaker: 'you', text: 'should be done by Thursday.', highlight: true },
    { t: 28,  speaker: 'you', text: "That's all from me.", flags: ['rushed'] },
  ];

  const score = d.score != null ? d.score : 72;
  const scoreTrend = d.scoreTrend || '↑ 14 from last standup';
  const avgPace = d.avgPace != null ? d.avgPace : '162';
  const avgPaceLabel = d.avgPaceLabel || 'In target zone';
  const avgPaceTone = d.avgPaceTone || 'good';
  const fillers = d.fillers != null ? d.fillers : 3;
  const fillersLabel = d.fillersLabel || '2 × "um", 1 × "uh"';
  const avgPause = d.avgPause != null ? d.avgPause : '0.8';
  const avgPauseLabel = d.avgPauseLabel || 'Up from 0.4s';
  const avgVolume = d.avgVolume != null ? d.avgVolume : '−22';
  const avgVolumeLabel = d.avgVolumeLabel || 'Steady';

  const fillerMarkers = d.fillerMarkers || [0.04, 0.18, 0.73];
  const paceSeries = d.paceSeries || null;

  const tips = d.tips || [
    { n: '1', text: 'Your "ums" clustered at the top of each sentence. Try a one-beat pause before you start — it kills the need for a filler.' },
    { n: '2', text: 'You rushed the close ("That\'s all from me"). Your buzz fired at 0:58. Land that line.' },
    { n: '3', text: 'Energy dipped after "no blockers." Next time, end on the ship date, not the summary.' },
  ];

  const onJumpTo = (t) => {
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = t;
        videoRef.current.play().catch(() => {});
      } catch {}
    }
    setScrub(Math.max(0, Math.min(1, t / duration)));
  };

  const onPlayPause = () => {
    const v = videoRef.current;
    if (v) {
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    } else {
      // no real video — just toggle the scrub visual baseline
      setIsPlaying(p => !p);
    }
  };

  // Sync scrub/isPlaying state from real <video> element when present.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (!v.duration) return;
      setScrub(v.currentTime / v.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [videoSrc]);

  return (
    <div style={{
      width: '100%', height: '100%', background: T.cream,
      fontFamily: T.sans, color: T.ink, overflow: 'hidden',
      display: 'grid',
      gridTemplateRows: '72px 1fr',
    }}>
      {/* top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', borderBottom: `1px solid ${T.line}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ReviewLogo />
          <div style={{ width: 1, height: 20, background: T.line }} />
          <a href="/train" style={{ fontSize: 14, color: T.inkSoft, textDecoration: 'none' }}>Sessions</a>
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.4 }}>
            <path d="M3 2l3 3-3 3" stroke={T.ink} strokeWidth="1.5" fill="none" strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{breadcrumb}</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <a href="/train" style={{ textDecoration: 'none' }}>
            <Pill tone="ghost">New session</Pill>
          </a>
          <Pill tone="neutral">Download</Pill>
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1.3fr 1fr',
        gap: 0, overflow: 'hidden',
      }}>
        {/* ─── left: hero / video + transcript ─── */}
        <div style={{
          padding: '32px 40px', overflow: 'auto',
          borderRight: `1px solid ${T.line}`,
        }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              {sessionLabel}
            </div>
            <h1 style={{
              fontFamily: T.display, fontSize: 48, letterSpacing: -1.2,
              lineHeight: 1.05, margin: 0, fontWeight: 400,
            }}>
              {heroLine1}<br/>
              <span style={{ color: T.inkMuted }}>{heroLine2}</span>
            </h1>
          </div>

          {/* Video scrubber */}
          <div style={{
            aspectRatio: '16 / 9', background: T.ink, borderRadius: T.rLg,
            position: 'relative', overflow: 'hidden', marginBottom: 18,
          }}>
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
                playsInline
              />
            ) : (
              <>
                <div style={{
                  position: 'absolute', inset: 0,
                  background: `radial-gradient(ellipse at 30% 40%, #3a3835, #141413)`,
                }} />
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Orb level={0.5} pace={0.55} state="calm" size={200} />
                </div>
              </>
            )}
            {/* play ctrl */}
            <div style={{
              position: 'absolute', bottom: 20, left: 20, right: 20,
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <button onClick={onPlayPause} style={{
                width: 44, height: 44, borderRadius: 999,
                background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)',
                backdropFilter: 'blur(12px)', color: '#fff', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {isPlaying ? (
                  <svg width="12" height="14" viewBox="0 0 12 14">
                    <rect x="1" y="1" width="3" height="12" rx="0.5" fill="#fff"/>
                    <rect x="8" y="1" width="3" height="12" rx="0.5" fill="#fff"/>
                  </svg>
                ) : (
                  <svg width="12" height="14" viewBox="0 0 12 14">
                    <path d="M2 1l9 6-9 6V1z" fill="#fff"/>
                  </svg>
                )}
              </button>
              <div
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  onJumpTo(pct * duration);
                }}
                style={{
                  flex: 1, height: 4, background: 'rgba(255,255,255,0.2)', borderRadius: 999,
                  position: 'relative', cursor: 'pointer',
                }}
              >
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${scrub * 100}%`, background: '#fff', borderRadius: 999,
                }} />
                {/* filler markers */}
                {fillerMarkers.map((p, i) => (
                  <div key={i} style={{
                    position: 'absolute', left: `${p * 100}%`, top: -4, bottom: -4,
                    width: 2, background: T.amber, borderRadius: 2,
                  }} />
                ))}
              </div>
              <div style={{ color: '#fff', fontSize: 13, fontFamily: T.mono }}>
                {fmtTime(scrub * duration)} / {fmtTime(duration)}
              </div>
            </div>
          </div>

          {/* Transcript */}
          <div style={{
            fontSize: 11, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14,
          }}>Transcript</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {transcriptChunks.map((c, i) => (
              <div key={i}
                onClick={() => onJumpTo(c.t)}
                style={{
                  display: 'flex', gap: 18, alignItems: 'flex-start', cursor: videoSrc ? 'pointer' : 'default',
                }}>
                <div style={{
                  fontFamily: T.mono, fontSize: 11, color: T.inkMuted,
                  width: 40, flexShrink: 0, paddingTop: 6,
                }}>{fmtTime(c.t)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: T.display, fontSize: 20, lineHeight: 1.4,
                    color: c.highlight ? T.ink : T.inkSoft,
                    background: c.highlight ? T.forestSoft : 'transparent',
                    padding: c.highlight ? '4px 10px' : 0,
                    borderRadius: 8, display: 'inline',
                    letterSpacing: -0.2,
                  }}>
                    {c.text.split(/(\bum\b|\buh\b)/i).map((part, j) => (
                      /^(um|uh)$/i.test(part) ? (
                        <span key={j} style={{
                          background: T.amberSoft, color: '#8A6120',
                          padding: '0 6px', borderRadius: 6, fontStyle: 'italic',
                        }}>{part}</span>
                      ) : <React.Fragment key={j}>{part}</React.Fragment>
                    ))}
                  </div>
                  {c.flags && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {c.flags.map(f => (
                        <Pill key={f} tone={f === 'filler' ? 'warn' : 'ghost'} size="sm">{f}</Pill>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ─── right: analytics ─── */}
        <div style={{
          padding: '32px 32px', overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 24,
        }}>
          {/* Score hero */}
          <Card pad={28} radius={T.rLg} tint={T.paper}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 12, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                  Delivery score
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ fontFamily: T.display, fontSize: 84, letterSpacing: -2.5, lineHeight: 0.9 }}>{score}</span>
                  <span style={{ fontSize: 20, color: T.inkMuted, fontFamily: T.display }}>/100</span>
                </div>
                {scoreTrend && (
                  <div style={{ fontSize: 13, color: T.forest, marginTop: 8 }}>
                    {scoreTrend}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'center' }}>
                <Orb level={0.4} pace={0.55} state="calm" size={88} />
              </div>
            </div>
          </Card>

          {/* Stats grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Card pad={20} radius={T.rMd}>
              <Stat value={avgPace} unit="wpm" label="Avg pace" tone={avgPaceTone} sub={avgPaceLabel} />
            </Card>
            <Card pad={20} radius={T.rMd}>
              <Stat value={fillers} label="Fillers" tone={fillers > 0 ? 'warn' : 'good'} sub={fillersLabel} />
            </Card>
            <Card pad={20} radius={T.rMd}>
              <Stat value={avgPause} unit="s" label="Avg pause" tone="ink" sub={avgPauseLabel} />
            </Card>
            <Card pad={20} radius={T.rMd}>
              <Stat value={avgVolume} unit="dB" label="Avg volume" tone="ink" sub={avgVolumeLabel} />
            </Card>
          </div>

          {/* Pace timeline */}
          <Card pad={22} radius={T.rMd}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                Pace over time
              </div>
              <span style={{ fontSize: 11, color: T.inkMuted, fontFamily: T.mono }}>wpm</span>
            </div>
            <PaceChart points={paceSeries} duration={duration} />
          </Card>

          {/* V-Bot tips */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{
                width: 18, height: 18, borderRadius: 6, background: T.terracotta,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontFamily: T.display, fontSize: 13, lineHeight: 1,
              }}>v</div>
              <div style={{ fontSize: 12, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                V-Bot · three things for next time
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tips.map((tip, i) => (
                <div key={tip.n || i} style={{
                  display: 'flex', gap: 14,
                  padding: '16px 18px', background: T.paper,
                  borderRadius: T.rMd, border: `1px solid ${T.line}`,
                }}>
                  <div style={{
                    fontFamily: T.display, fontSize: 22, color: T.terracotta,
                    lineHeight: 1, flexShrink: 0, width: 22,
                  }}>{tip.n || String(i + 1)}</div>
                  <div style={{ fontSize: 14, lineHeight: 1.55, color: T.inkSoft }}>
                    {tip.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewLogo() {
  return (
    <a href="/train" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8,
        background: T.ink, color: T.cream,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: T.display, fontSize: 18, lineHeight: 1,
      }}>b</div>
      <span style={{
        fontFamily: T.display, fontSize: 20, letterSpacing: -0.3, color: T.ink,
      }}>buzzline</span>
    </a>
  );
}

function PaceChart({ points: pointsProp, duration: durationProp } = {}) {
  const points = pointsProp && pointsProp.length ? pointsProp
    : [155, 162, 170, 182, 175, 160, 158, 165, 172, 180, 185, 178, 168, 160, 155, 162, 170];
  const targetLow = 140, targetHigh = 180;
  const min = 120, max = 200;
  const w = 360, h = 100;
  const px = (i) => (i / (points.length - 1)) * w;
  const py = (v) => h - ((v - min) / (max - min)) * h;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${px(i)} ${py(Math.max(min, Math.min(max, p)))}`).join(' ');
  const fillPath = path + ` L ${w} ${h} L 0 ${h} Z`;
  const dur = durationProp || 124;
  const endLabel = `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h + 20}`} style={{ display: 'block' }}>
      {/* target band */}
      <rect x={0} y={py(targetHigh)} width={w} height={py(targetLow) - py(targetHigh)} fill={T.forestSoft} opacity={0.6} />
      <line x1={0} y1={py(targetLow)} x2={w} y2={py(targetLow)} stroke={T.forest} strokeWidth={0.5} strokeDasharray="3 3" />
      <line x1={0} y1={py(targetHigh)} x2={w} y2={py(targetHigh)} stroke={T.forest} strokeWidth={0.5} strokeDasharray="3 3" />
      <path d={fillPath} fill={T.terracotta} opacity={0.1} />
      <path d={path} stroke={T.terracotta} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => {
        const over = p > targetHigh;
        return over ? (
          <circle key={i} cx={px(i)} cy={py(Math.min(max, p))} r={3} fill={T.rose} />
        ) : null;
      })}
      <text x={0} y={h + 14} fontSize={10} fill={T.inkMuted} fontFamily={T.mono}>0:00</text>
      <text x={w} y={h + 14} fontSize={10} fill={T.inkMuted} fontFamily={T.mono} textAnchor="end">{endLabel}</text>
    </svg>
  );
}

Object.assign(window, { ReviewScreen, PaceChart });
