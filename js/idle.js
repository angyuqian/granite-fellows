// Ambient motion.
//
// Idle orbit: after 15 s without input, the 3D camera eases into a very slow
// orbit around whatever it is looking at (~1 turn per 4 min) with a slight rise
// and fall. Any input stops it where it is. Camera only: time, scenario and
// pop-ups are untouched. Toggle with the orbit button or O; remembered.
//
// Attract mode (A key, #attract=1, or automatically on the public site): orbit at
// once and play the day on a slow loop, alternating the demo and cloudy days, with
// a hint on screen. A click, tap, scroll or key ends it (not mere mouse movement,
// so a visitor's drifting cursor doesn't), and the clock jumps to a set start.

const IDLE_MS = 15000;
const TURN_S = 240;           // one full orbit every 4 minutes
// Rotation is time-based, not per frame, so it runs at the same speed on a 60 Hz
// monitor and a 120 Hz MacBook display (OrbitControls' autoRotate is per frame).
const EASE_S = 2.5;
const BREATHE = 0.025;        // camera height swing, fraction of viewing distance
const BREATHE_S = 40;         // one rise-and-fall cycle
const ATTRACT_STEP_MS = 450;  // one 15-min step; a day in ~43 s
const KEY = 'mgo.orbit';

export function createIdle(map, { getTime, setTime, days, onAttractEnd }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = !reduced;
  try { if (localStorage.getItem(KEY) === 'off') enabled = false; } catch {}

  const btn = document.getElementById('orbit-btn');
  const hint = document.getElementById('attract-hint');
  let lastInput = performance.now();
  let speed = 0, phase = 0, lastNow = performance.now(), prevLift = 0;
  let attract = 0;              // interval id while attract mode runs

  function stop() {
    speed = 0;
    prevLift = 0;
    phase = 0;
    if (attract) {
      clearInterval(attract);
      attract = 0;
      btn.classList.remove('attract');
      hint.hidden = true;
      onAttractEnd?.();
    }
  }
  function onInput(e) {
    if (attract && e.type === 'pointermove') return;
    lastInput = performance.now();
    if (speed > 0 || attract) stop();
  }
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'])
    window.addEventListener(ev, onInput, { capture: true, passive: true });

  const tick = now => {
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    const idle = now - lastInput > IDLE_MS;
    const run = map.mode === '3d' && (attract || (enabled && idle));
    if (!run) {
      if (speed > 0) stop();
      return;
    }
    speed = Math.min(1, speed + dt / EASE_S);                 // 0 -> 1 ease-in
    // orbit: rotate the camera about the vertical axis through the look-at point
    const t = map.controls.target, c = map.camera.position;
    const a = speed * (2 * Math.PI / TURN_S) * dt;
    const dx = c.x - t.x, dz = c.z - t.z, ca = Math.cos(a), sa = Math.sin(a);
    c.x = t.x + dx * ca - dz * sa;
    c.z = t.z + dx * sa + dz * ca;
    // breathe: move the camera up and down by the change in a slow sine
    phase += dt;
    const dist = c.distanceTo(t);
    const lift = BREATHE * dist * Math.sin((2 * Math.PI * phase) / BREATHE_S) * speed;
    c.y += lift - prevLift;
    prevLift = lift;
    map.camera.lookAt(t);
  };
  map.onFrame(tick);

  function setEnabled(on) {
    enabled = on;
    btn.setAttribute('aria-pressed', on);
    btn.title = on ? 'Idle orbit on: the 3D view drifts after 15 s untouched (O to toggle, A for attract mode)'
                   : 'Idle orbit off (O to toggle, A for attract mode)';
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
    if (!on) stop();
  }

  function startAttract() {
    stop();
    if (map.mode !== '3d') document.querySelector('[data-view="3d"]')?.click();
    btn.classList.add('attract');
    hint.hidden = false;
    // the click and key that started it must not count as "input" that ends it
    setTimeout(() => {
      attract = setInterval(() => {
        const { day, step } = getTime();
        if (step >= 95) setTime(days[(days.indexOf(day) + 1) % days.length], 0);
        else setTime(day, step + 1);
      }, ATTRACT_STEP_MS);
    }, 50);
  }

  btn.addEventListener('click', () => setEnabled(!enabled));
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'o' || e.key === 'O') setEnabled(!enabled);
    if (e.key === 'a' || e.key === 'A') startAttract();
  });

  setEnabled(enabled);
  return { startAttract, setEnabled, get enabled() { return enabled; } };
}
