// Orb — the Duo-like focal creature for Buzz
// A breathing, voice-reactive blob with a soft face.
// Props:
//   level   0..1 voice amplitude (dBFS-normalized)
//   pace    0..1 words-per-minute normalized (0.5 = on pace)
//   state   'idle' | 'listening' | 'alert' | 'calm'
//   size    px
//
// Visual mapping:
//   level -> radius pulse + inner shine
//   pace  -> squish (fast = tall & narrow, slow = wide & short)
//   state -> mouth + eye expression, color wash

function Orb({ level = 0, pace = 0.5, state = 'listening', size = 280 }) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let raf;
    const loop = () => { setTick(t => t + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Breathing baseline (slow sine)
  const t = tick * 0.016;
  const breathe = Math.sin(t * 1.2) * 0.015;

  // Level drives radius; pace drives squish
  const lvl = Math.max(0, Math.min(1, level));
  const pc = Math.max(0, Math.min(1, pace));

  const scaleBase = 1 + breathe + lvl * 0.08;
  // pace 0 (slow) -> wider, 1 (fast) -> taller
  const sx = scaleBase * (1 - (pc - 0.5) * 0.18);
  const sy = scaleBase * (1 + (pc - 0.5) * 0.18);

  // Color by state
  const palette = {
    listening: { fill: T.terracotta, shine: '#F39999', deep: T.terracottaDeep },
    alert:     { fill: T.rose,       shine: '#EBA1A1', deep: '#8A3B3B' },
    calm:      { fill: T.forest,     shine: '#8FC19E', deep: '#1F4229' },
    idle:      { fill: '#C9C2B3',    shine: '#E3DDCE', deep: '#8E887A' },
  }[state];

  // Eye squint on alert, wide on calm
  const eyeOpen = state === 'alert' ? 0.55 : state === 'idle' ? 0.7 : 0.9 - lvl * 0.15;

  // Mouth: pace > 0.7 = "o" wide, pace < 0.3 = flat, neutral otherwise
  const mouthMode = pc > 0.7 ? 'fast' : pc < 0.3 ? 'slow' : 'neutral';

  const w = size, h = size;
  const cx = w / 2, cy = h / 2;
  const r = size * 0.35;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`orb-grad-${state}`} cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor={palette.shine} />
          <stop offset="55%" stopColor={palette.fill} />
          <stop offset="100%" stopColor={palette.deep} />
        </radialGradient>
        <filter id="orb-soft">
          <feGaussianBlur stdDeviation="0.5" />
        </filter>
      </defs>

      {/* Outer halo — pulses with level */}
      <circle
        cx={cx} cy={cy} r={r * 1.35}
        fill={palette.fill}
        opacity={0.08 + lvl * 0.12}
        style={{
          transform: `translate(${cx}px, ${cy}px) scale(${1 + lvl * 0.15}) translate(${-cx}px, ${-cy}px)`,
          transformOrigin: 'center',
          transition: 'opacity 120ms',
        }}
      />
      <circle
        cx={cx} cy={cy} r={r * 1.15}
        fill={palette.fill}
        opacity={0.15 + lvl * 0.15}
        style={{
          transform: `translate(${cx}px, ${cy}px) scale(${1 + lvl * 0.08}) translate(${-cx}px, ${-cy}px)`,
          transformOrigin: 'center',
        }}
      />

      {/* Body */}
      <g style={{
        transform: `translate(${cx}px, ${cy}px) scale(${sx}, ${sy}) translate(${-cx}px, ${-cy}px)`,
        transformOrigin: 'center',
        transition: 'transform 80ms ease-out',
      }}>
        <circle cx={cx} cy={cy} r={r} fill={`url(#orb-grad-${state})`} />

        {/* Top shine */}
        <ellipse
          cx={cx - r * 0.25} cy={cy - r * 0.35}
          rx={r * 0.35} ry={r * 0.22}
          fill="#fff" opacity={0.35}
        />

        {/* Face group — eyes + mouth. Slight bob */}
        <g style={{
          transform: `translateY(${Math.sin(t * 0.9) * 2}px)`,
          transformOrigin: 'center',
        }}>
          {/* Left eye */}
          <ellipse
            cx={cx - r * 0.3} cy={cy - r * 0.05}
            rx={r * 0.07} ry={r * 0.1 * eyeOpen}
            fill={palette.deep}
          />
          {/* Right eye */}
          <ellipse
            cx={cx + r * 0.3} cy={cy - r * 0.05}
            rx={r * 0.07} ry={r * 0.1 * eyeOpen}
            fill={palette.deep}
          />
          {/* Eye highlights */}
          <circle cx={cx - r * 0.28} cy={cy - r * 0.08} r={r * 0.022} fill="#fff" opacity={eyeOpen} />
          <circle cx={cx + r * 0.32} cy={cy - r * 0.08} r={r * 0.022} fill="#fff" opacity={eyeOpen} />

          {/* Mouth */}
          {mouthMode === 'fast' && (
            <ellipse cx={cx} cy={cy + r * 0.28} rx={r * 0.09} ry={r * 0.13} fill={palette.deep} />
          )}
          {mouthMode === 'slow' && (
            <rect x={cx - r * 0.12} y={cy + r * 0.28} width={r * 0.24} height={r * 0.04} rx={r * 0.02} fill={palette.deep} />
          )}
          {mouthMode === 'neutral' && (
            <path
              d={`M ${cx - r * 0.15} ${cy + r * 0.25} Q ${cx} ${cy + r * 0.35} ${cx + r * 0.15} ${cy + r * 0.25}`}
              stroke={palette.deep} strokeWidth={r * 0.035} fill="none" strokeLinecap="round"
            />
          )}
        </g>
      </g>
    </svg>
  );
}

Object.assign(window, { Orb });
