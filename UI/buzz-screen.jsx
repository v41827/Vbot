// BuzzScreen — the phone /buzz surface. iOS frame.
// Two modes:
//   idle  : minimal readout, ambient + Buzz paired
//   flash : full-bleed color takeover when the model fires a nudge

function BuzzScreen({ mode = 'idle', nudge = 'pace', recentNudges, connected = true }) {
  const [now, setNow] = React.useState(0);
  React.useEffect(() => {
    let raf;
    const loop = () => { setNow(t => t + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pulse = Math.sin(now * 0.06) * 0.5 + 0.5;

  const nudges = {
    pace:    { label: 'Slow down', sub: 'One tap · pace', color: T.amber,      tint: T.amberSoft, deep: '#8A6120' },
    volume:  { label: 'Speak up',  sub: 'Two taps · volume', color: T.terracotta, tint: T.terracottaSoft, deep: T.terracottaDeep },
    filler:  { label: 'Drop the "um"', sub: 'Long buzz · filler', color: T.rose, tint: T.roseSoft, deep: '#8A3B3B' },
    breathe: { label: 'Breathe',   sub: 'Soft wave · reset',   color: T.forest, tint: T.forestSoft, deep: '#1F4229' },
  }[nudge];

  if (mode === 'flash') {
    return (
      <div style={{
        width: '100%', height: '100%', background: nudges.color,
        display: 'flex', flexDirection: 'column',
        fontFamily: T.sans, color: '#fff', position: 'relative',
      }}>
        {/* breathing halo */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at center, rgba(255,255,255,${0.15 + pulse * 0.15}), transparent 60%)`,
          pointerEvents: 'none',
        }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 32px' }}>
          <div style={{
            fontFamily: T.display, fontSize: 72, lineHeight: 0.95,
            letterSpacing: -2, marginBottom: 20,
          }}>{nudges.label}</div>
          <div style={{ fontSize: 16, opacity: 0.85, letterSpacing: -0.1 }}>
            {nudges.sub}
          </div>
        </div>
        <div style={{ padding: '0 32px 56px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, opacity: 0.8,
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: 999, background: '#fff',
              opacity: 0.5 + pulse * 0.5,
            }} />
            Buzz paired · tap to dismiss
          </div>
        </div>
      </div>
    );
  }

  // idle
  return (
    <div style={{
      width: '100%', height: '100%', background: T.cream,
      fontFamily: T.sans, color: T.ink,
      display: 'flex', flexDirection: 'column',
      padding: '70px 24px 40px', boxSizing: 'border-box',
    }}>
      {/* top meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 36 }}>
        <div style={{ fontFamily: T.display, fontSize: 22, letterSpacing: -0.3 }}>buzz</div>
        <Pill tone={connected ? 'good' : 'neutral'} size="sm">
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: connected ? T.forest : T.inkMuted,
            opacity: 0.5 + pulse * 0.5,
          }} />
          {connected ? 'Live' : 'Offline'}
        </Pill>
      </div>

      {/* orb */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
        <Orb level={0.3 + pulse * 0.2} pace={0.55} state="calm" size={200} />
      </div>

      {/* session line */}
      <div style={{
        textAlign: 'center', marginBottom: 32,
      }}>
        <div style={{ fontSize: 13, color: T.inkMuted, marginBottom: 8, letterSpacing: 0.3 }}>
          SESSION · STANDUP
        </div>
        <div style={{ fontFamily: T.display, fontSize: 34, lineHeight: 1.1, letterSpacing: -0.8 }}>
          Listening softly.
        </div>
      </div>

      {/* dials */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20,
      }}>
        <Card pad={16} radius={T.rMd}>
          <div style={{ fontSize: 10, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Pace</div>
          <div style={{ fontFamily: T.display, fontSize: 28, letterSpacing: -0.5, lineHeight: 1 }}>
            162<span style={{ fontSize: 12, color: T.inkMuted, fontFamily: T.sans, marginLeft: 2 }}>wpm</span>
          </div>
          <div style={{ marginTop: 8, height: 4, borderRadius: 999, background: T.paperDeep, overflow: 'hidden' }}>
            <div style={{ width: '62%', height: '100%', background: T.forest }} />
          </div>
        </Card>
        <Card pad={16} radius={T.rMd}>
          <div style={{ fontSize: 10, color: T.inkMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Volume</div>
          <div style={{ fontFamily: T.display, fontSize: 28, letterSpacing: -0.5, lineHeight: 1 }}>
            -24<span style={{ fontSize: 12, color: T.inkMuted, fontFamily: T.sans, marginLeft: 2 }}>dB</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Waveform level={0.4 + pulse * 0.2} bars={18} color={T.terracotta} height={16} />
          </div>
        </Card>
      </div>

      {/* recent nudges */}
      <div style={{
        fontSize: 11, fontWeight: 500, color: T.inkMuted,
        textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
      }}>Recent nudges</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        {(recentNudges || [
          { label: 'Slow down', t: '12s ago', tone: 'warn' },
          { label: 'Nice pace', t: '48s ago', tone: 'good' },
          { label: 'Drop "um"', t: '1m ago',  tone: 'alert' },
        ]).map((n, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: T.paper, borderRadius: 14,
            border: `1px solid ${T.line}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 6, height: 6, borderRadius: 999,
                background: n.tone === 'good' ? T.forest : n.tone === 'warn' ? T.amber : T.rose,
              }} />
              <span style={{ fontSize: 14 }}>{n.label}</span>
            </div>
            <span style={{ fontSize: 12, color: T.inkMuted, fontFamily: T.mono }}>{n.t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { BuzzScreen });
