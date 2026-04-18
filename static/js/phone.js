(() => {
  const bg = document.getElementById("phone-bg");
  const big = document.getElementById("phone-big");
  const arm = document.getElementById("phone-arm");
  const test = document.getElementById("phone-test");
  const dot = document.getElementById("phone-connection");
  const connLabel = document.getElementById("phone-connection-label");

  let armed = false;
  let ws = null;
  let wakeLock = null;

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch {}
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/phone`);
    ws.onopen = () => {
      dot.classList.add("on");
      connLabel.textContent = "Linked";
    };
    ws.onclose = () => {
      dot.classList.remove("on");
      connLabel.textContent = "Reconnecting…";
      setTimeout(connect, 1200);
    };
    ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  }

  function handleMessage(msg) {
    if (msg.type === "buzz") doBuzz(msg);
  }

  function doBuzz({ kind, vibration_ms, colour, hold_ms }) {
    if (!armed) return;
    bg.style.backgroundColor = colour;
    big.textContent = kind === "loud" ? "Quieter" : "Clearer";
    if (navigator.vibrate) {
      if (kind === "loud") {
        navigator.vibrate([vibration_ms, 40, vibration_ms]);
      } else {
        navigator.vibrate(vibration_ms);
      }
    }
    setTimeout(() => {
      bg.style.backgroundColor = "#000";
      big.textContent = "Ready";
    }, hold_ms || 400);
  }

  arm.addEventListener("click", async () => {
    armed = true;
    // prime vibration by requiring one user tap first
    if (navigator.vibrate) navigator.vibrate(30);
    requestWakeLock();
    arm.remove();
    big.textContent = "Ready";
  });

  test.addEventListener("click", () => {
    if (!armed) {
      big.textContent = "Tap arm first";
      return;
    }
    doBuzz({ kind: "loud", vibration_ms: 120, colour: "#ff3b30", hold_ms: 400 });
    setTimeout(() => {
      doBuzz({ kind: "quiet", vibration_ms: 500, colour: "#0a84ff", hold_ms: 400 });
    }, 900);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  connect();
})();
