// Shared UI atoms: Pill, Card, Stat, Waveform, KineticText

function Pill({ children, tone = 'neutral', size = 'md' }) {
  const tones = {
    neutral: { bg: T.paperDeep, fg: T.inkSoft, border: 'transparent' },
    accent:  { bg: T.terracottaSoft, fg: T.terracottaDeep, border: 'transparent' },
    good:    { bg: T.forestSoft, fg: T.forest, border: 'transparent' },
    warn:    { bg: T.amberSoft, fg: '#8A6120', border: 'transparent' },
    alert:   { bg: T.roseSoft, fg: '#8A3B3B', border: 'transparent' },
    ghost:   { bg: 'transparent', fg: T.inkSoft, border: T.lineStrong },
  }[tone];
  const sizes = {
    sm: { fs: 12, pad: '4px 10px', h: 24 },
    md: { fs: 13, pad: '6px 14px', h: 30 },
    lg: { fs: 14, pad: '8px 18px', h: 36 },
  }[size];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: tones.bg, color: tones.fg,
      border: `1px solid ${tones.border}`,
      padding: sizes.pad, height: sizes.h,
      fontSize: sizes.fs, fontWeight: 500, letterSpacing: -0.1,
      borderRadius: 9999, fontFamily: T.sans, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Card({ children, pad = 28, radius = T.rLg, style = {}, tint = T.paper }) {
  return (
    <div style={{
      background: tint, borderRadius: radius, padding: pad,
      border: `1px solid ${T.line}`,
      ...style,
    }}>{children}</div>
  );
}

// Big numeric stat — Duolingo-like confident type
function Stat({ value, unit, label, tone = 'ink', sub, trend }) {
  const colors = {
    ink: T.ink, accent: T.terracottaDeep, good: T.forest, warn: '#8A6120', alert: '#8A3B3B',
  };
  return (
    <div>
      <div style={{
        fontSize: 12, fontWeight: 500, color: T.inkMuted,
        textTransform: 'uppercase', letterSpacing: 1,
        fontFamily: T.sans, marginBottom: 10,
      }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontSize: 52, fontFamily: T.display, color: colors[tone],
          lineHeight: 0.9, letterSpacing: -1.5, fontWeight: 400,
        }}>{value}</span>
        {unit && (
          <span style={{
            fontSize: 16, color: T.inkMuted, fontFamily: T.sans, fontWeight: 500,
          }}>{unit}</span>
        )}
        {trend && (
          <span style={{ marginLeft: 8, fontSize: 13, color: trend.startsWith('-') ? T.forest : T.rose }}>
            {trend}
          </span>
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 13, color: T.inkMuted, marginTop: 8, fontFamily: T.sans }}>{sub}</div>
      )}
    </div>
  );
}

// Live waveform — reactive bars from level
function Waveform({ level = 0, bars = 48, color = T.ink, height = 72 }) {
  const [seed, setSeed] = React.useState(0);
  React.useEffect(() => {
    let raf;
    const loop = () => { setSeed(s => s + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const barArr = [];
  for (let i = 0; i < bars; i++) {
    // shape: ease in from left, out at right, with level-driven pulse
    const wave = Math.sin((seed * 0.12 + i * 0.5)) * 0.5 + 0.5;
    const wave2 = Math.sin((seed * 0.07 + i * 0.3)) * 0.5 + 0.5;
    const env = Math.sin((i / bars) * Math.PI);
    const h = Math.max(4, (wave * 0.6 + wave2 * 0.4) * env * level * height + 3);
    barArr.push(h);
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 3,
      height, width: '100%',
    }}>
      {barArr.map((h, i) => (
        <div key={i} style={{
          flex: 1, height: h, background: color,
          borderRadius: 3, opacity: 0.75,
          transition: 'height 60ms linear',
        }} />
      ))}
    </div>
  );
}

// Kinetic text — words fade in one at a time
function KineticText({ text, style = {} }) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const [seen, setSeen] = React.useState(0);
  const lastText = React.useRef('');
  React.useEffect(() => {
    if (text !== lastText.current) {
      lastText.current = text;
      setSeen(0);
    }
  }, [text]);
  React.useEffect(() => {
    if (seen < words.length) {
      const timer = setTimeout(() => setSeen(s => s + 1), 90);
      return () => clearTimeout(timer);
    }
  }, [seen, words.length]);
  return (
    <span style={style}>
      {words.map((w, i) => (
        <span key={i} style={{
          display: 'inline-block',
          opacity: i < seen ? 1 : 0,
          transform: i < seen ? 'translateY(0)' : 'translateY(6px)',
          transition: 'opacity 260ms ease, transform 260ms ease',
          marginRight: '0.3em',
        }}>{w}</span>
      ))}
    </span>
  );
}

// Pace meter — horizontal scale with needle
function PaceMeter({ pace = 0.5, wpm = 165, targetMin = 140, targetMax = 180 }) {
  const pct = Math.max(0, Math.min(1, pace)) * 100;
  const targetLow = 35, targetHigh = 65;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <div style={{
            fontSize: 12, fontWeight: 500, color: T.inkMuted,
            textTransform: 'uppercase', letterSpacing: 1, fontFamily: T.sans,
          }}>Pace</div>
          <div style={{ fontFamily: T.display, fontSize: 36, color: T.ink, letterSpacing: -0.5, marginTop: 6, lineHeight: 1 }}>
            {wpm} <span style={{ fontSize: 14, color: T.inkMuted, fontFamily: T.sans }}>wpm</span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: T.inkMuted, fontFamily: T.mono, marginBottom: 4 }}>
          target {targetMin}–{targetMax}
        </div>
      </div>
      <div style={{
        position: 'relative', height: 14, background: T.paperDeep,
        borderRadius: 999, overflow: 'hidden',
      }}>
        {/* target band */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: `${targetLow}%`, width: `${targetHigh - targetLow}%`,
          background: T.forestSoft,
        }} />
        {/* tick marks */}
        {[0, 25, 50, 75, 100].map(p => (
          <div key={p} style={{
            position: 'absolute', top: 3, bottom: 3, left: `${p}%`,
            width: 1, background: 'rgba(20,20,19,0.1)',
          }} />
        ))}
        {/* needle */}
        <div style={{
          position: 'absolute', top: -4, bottom: -4,
          left: `calc(${pct}% - 2px)`, width: 4,
          background: T.ink, borderRadius: 4,
          transition: 'left 120ms ease-out',
          boxShadow: '0 0 0 2px #FBF8F1',
        }} />
      </div>
    </div>
  );
}

Object.assign(window, { Pill, Card, Stat, Waveform, KineticText, PaceMeter });
