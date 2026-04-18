/* ui-phone.jsx — connects /ws/phone to the BuzzScreen UI.
 *
 *  - "idle"  -> the cream ambient screen (orb + session line + recent nudges)
 *  - "flash" -> full-bleed coloured takeover when the server sends a buzz.
 *
 *  Server sends { type: "buzz", kind: "loud"|"quiet", vibration_ms, colour, hold_ms }.
 *  We map to the UI's nudge vocabulary and trigger device vibration.
 */

(() => {
  const $overlay = document.getElementById('arm-overlay');
  const $armBtn = document.getElementById('btn-arm');
  const $connDot = document.getElementById('conn-dot');
  const $connLabel = document.getElementById('conn-label');

  function setConnStatusOverlay(on, label) {
    if ($connDot) $connDot.classList.toggle('on', !!on);
    if ($connLabel) $connLabel.textContent = label || (on ? 'Linked' : 'Connecting…');
  }

  // Shared "armed" flag — the React app reads this to decide whether to
  // trigger vibration / flash on a buzz. User must tap once before the
  // browser lets us vibrate.
  const armedRef = { value: false };

  // Backend vocabulary: "loud" (too loud) / "quiet" (too soft).
  // UI vocabulary: pace | volume | filler | breathe
  function kindToNudge(kind) {
    if (kind === 'loud') return 'filler';   // rose / alert — calm down
    if (kind === 'quiet') return 'volume';  // terracotta / speak up
    if (kind === 'filler') return 'filler';
    if (kind === 'breathe') return 'breathe';
    if (kind === 'pace') return 'pace';
    return 'volume';
  }

  function App() {
    const [mode, setMode] = React.useState('idle');
    const [nudge, setNudge] = React.useState('volume');
    const [recent, setRecent] = React.useState([]);
    const [connected, setConnected] = React.useState(false);
    const flashTimerRef = React.useRef(null);
    const wsRef = React.useRef(null);

    const labelForNudge = (n) => ({
      pace: 'Slow down',
      volume: 'Speak up',
      filler: 'Drop the "um"',
      breathe: 'Breathe',
    })[n] || 'Buzz';

    const toneForNudge = (n) => ({
      pace: 'warn', volume: 'alert', filler: 'alert', breathe: 'good',
    })[n] || 'warn';

    const pushRecent = React.useCallback((label, tone) => {
      setRecent(rs => [{ label, tone, ts: Date.now() }, ...rs].slice(0, 3));
    }, []);

    React.useEffect(() => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/phone`;
      let reconnectTo = null;
      let alive = true;

      function connect() {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          setConnStatusOverlay(true, 'Linked');
        };
        ws.onclose = () => {
          setConnected(false);
          setConnStatusOverlay(false, 'Reconnecting…');
          if (alive) reconnectTo = setTimeout(connect, 1200);
        };
        ws.onerror = () => {/* onclose will reconnect */};
        ws.onmessage = (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.type === 'buzz') {
            triggerBuzz(msg);
          }
        };
      }

      function triggerBuzz(msg) {
        const n = kindToNudge(msg.kind);
        setNudge(n);
        setMode('flash');
        pushRecent(labelForNudge(n), toneForNudge(n));

        if (armedRef.value && navigator.vibrate) {
          try {
            if (msg.kind === 'loud') {
              navigator.vibrate([msg.vibration_ms || 120, 40, msg.vibration_ms || 120]);
            } else if (msg.kind === 'quiet') {
              navigator.vibrate(msg.vibration_ms || 600);
            } else {
              navigator.vibrate(msg.vibration_ms || 200);
            }
          } catch {}
        }

        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setMode('idle');
        }, msg.hold_ms || 1400);
      }

      connect();

      return () => {
        alive = false;
        if (reconnectTo) clearTimeout(reconnectTo);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        try { wsRef.current && wsRef.current.close(); } catch {}
      };
    }, [pushRecent]);

    // Wake lock so the phone screen stays on while paired.
    React.useEffect(() => {
      let lock = null;
      const acquire = async () => {
        if (!('wakeLock' in navigator)) return;
        try { lock = await navigator.wakeLock.request('screen'); } catch {}
      };
      acquire();
      const onVis = () => {
        if (document.visibilityState === 'visible') acquire();
      };
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    return (
      <BuzzScreen
        mode={mode}
        nudge={nudge}
        recentNudges={recent.length ? recent.map(r => ({
          label: r.label,
          t: humanAgo(r.ts),
          tone: r.tone,
        })) : undefined}
        connected={connected}
      />
    );
  }

  function humanAgo(ts) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 45) return `${sec}s ago`;
    const m = Math.round(sec / 60);
    return `${m}m ago`;
  }

  // Arm overlay — once tapped we can actually vibrate.
  if ($armBtn) {
    $armBtn.addEventListener('click', () => {
      armedRef.value = true;
      try { if (navigator.vibrate) navigator.vibrate(30); } catch {}
      if ($overlay) $overlay.classList.add('hidden');
    });
  }

  // Mount immediately so the screen shows behind the arm overlay and the
  // connection indicator is accurate while the user reads the pair copy.
  function mount() {
    if (!window.BuzzScreen) return setTimeout(mount, 50);
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(mount, 0);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 0));
  }
})();
