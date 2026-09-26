// "How it works": a stepped architecture diagram for presenting the concept.
// Layers, top to bottom: orchestrator -> canonical data model -> resource
// adapters (each with its own local model) -> field devices and local control.
// Each step highlights one part and can hand off to a live console query.

const STEPS = [
  { focus: ['devices', 'adapters'], title: 'Every resource is different',
    text: `Solar, batteries, generators, the utility tie, EV chargers and <b>buildings</b> each speak a different protocol
      (SunSpec, Modbus, BACnet, OCPP) and obey different physics. Integrating them usually means custom logic per asset,
      and a redesign every time something new is added.` },
  { focus: ['adapters'], title: 'Resource adapters: each resource models itself',
    text: `One adapter per resource type translates its device <i>and its own physics</i> into what it can do next.
      The building adapter runs a thermal model of the zone to work out how much cooling it can defer without leaving
      its comfort band, and what that costs to repay.`,
    try: ['Show a building\'s offer', 'What can SDE4 offer?'] },
  { focus: ['cdm'], title: 'Canonical data model: one object for every asset',
    text: `Every adapter publishes the same <b>CapabilityOffer</b>: power bounds, prices, and a fixed library of five
      constraint primitives. A battery is <code>bounds + ramp + storage</code>; a building is
      <code>bounds + recovery</code>. The hard part isn't the format; it's expressing a building's time-coupled,
      self-repaying flexibility in the same terms as a battery.` },
  { focus: ['orch'], title: 'Orchestrator: one optimisation across everything',
    text: `Every 15 minutes a mixed-integer linear program chooses setpoints for all assets together: cheapest and
      cleanest, and <b>never</b> breaking a hard limit (battery floor, comfort band, generator minimum load, critical
      load). It sees only offers, never device types; an automated check proves the engine has no asset-specific code.`,
    try: ['Run the outage', 'The grid just failed at 13:00'] },
  { focus: ['verify', 'scope'], title: 'Verified, and honest about scope',
    text: `After each solve, every building's physics is re-simulated on the cooling it was actually given, so a broken
      comfort promise shows up instead of being assumed away. Below this layer, local controllers own protection,
      grid-forming and the islanding transition; this layer sets targets on a minutes timescale.` },
  { focus: ['adapters', 'orch'], highlight: 'ev', title: 'Adding a new resource',
    text: `A managed EV fleet is a new kind of asset: a load with a hard departure deadline. It needs a new adapter
      that uses the existing <code>storage</code> primitive, and <b>zero lines change in the orchestrator</b>.`,
    try: ['Register the EV fleet', 'Register an EV fleet'] },
];

export function createConcept(ask) {
  const modal = document.getElementById('concept');
  const body = modal.querySelector('.concept-text');
  const dots = modal.querySelector('.concept-dots');
  let step = 0;

  dots.innerHTML = STEPS.map((s, i) => `<button data-step="${i}" aria-label="Step ${i + 1}: ${s.title}">${i + 1}</button>`).join('');

  function render() {
    const s = STEPS[step];
    modal.querySelectorAll('[data-layer]').forEach(el => {
      el.classList.toggle('dim', !s.focus.includes(el.dataset.layer));
    });
    modal.querySelectorAll('[data-res]').forEach(el =>
      el.classList.toggle('hl', !!s.highlight && el.dataset.res === s.highlight));
    dots.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-current', i === step));
    body.innerHTML = `<span class="concept-step">Step ${step + 1} of ${STEPS.length}</span>
      <h3>${s.title}</h3><p>${s.text}</p>
      ${s.try ? `<button class="concept-try" data-try>${s.try[0]} on the map →</button>` : ''}`;
    body.querySelector('[data-try]')?.addEventListener('click', () => { close(); ask(s.try[1]); });
    modal.querySelector('[data-prev]').disabled = step === 0;
    modal.querySelector('[data-next]').textContent = step === STEPS.length - 1 ? 'Done' : 'Next';
  }
  function open(i = 0) { step = i; render(); modal.hidden = false; }
  function close() { modal.hidden = true; }

  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-prev]')) { step = Math.max(0, step - 1); return render(); }
    if (e.target.closest('[data-next]')) {
      if (step === STEPS.length - 1) return close();
      step++; return render();
    }
    const d = e.target.closest('[data-step]');
    if (d) { step = +d.dataset.step; render(); }
  });
  // while open, arrow keys step the diagram instead of the clock
  document.addEventListener('keydown', e => {
    if (modal.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') { step = Math.min(STEPS.length - 1, step + 1); render(); }
    else if (e.key === 'ArrowLeft') { step = Math.max(0, step - 1); render(); }
    else return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  return { open, close };
}
