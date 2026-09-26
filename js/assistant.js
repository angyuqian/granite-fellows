// Scripted assistant. It looks like a chat, but every answer is computed from
// the campus data and the pre-solved dispatch, and most answers also drive the
// map. No model, no network: it cannot fail on stage. Free text is routed to
// the same answers by keyword.
//
// Reply markup (rendered after streaming): **bold**, `code`, {b:Building name}
// (click to fly there), lines starting "- " become bullets, ``` fences a block.

const ARCH = { academic: 'academic', lab: 'research lab', residential: 'residential', assembly: 'assembly' };
const PRECINCT_WORDS = [
  ['engineering', /engineer|cde|sde|e-?block/i],
  ['science', /science|medicine|medical|lab precinct|\bmd\b/i],
  ['arts', /arts?\b|fass|central library|biz|computing|com\d?/i],
  ['utown', /utown|university town/i],
  ['pgp', /pgp|prince george|residential precinct|halls?/i],
];

export function createAssistant(app) {
  const { map, mg, campus, weather, stations, ev } = app;
  const $ = s => document.querySelector(s);
  const log = $('#chat-log'), input = $('#chat-input'), form = $('#chat-form');
  const kw = x => x >= 1000 ? `${(x / 1000).toFixed(1)} MW` : `${Math.round(x)} kW`;
  const n0 = x => Math.round(x).toLocaleString('en-SG');
  const hhmm = k => `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`;
  const byName = new Map(map.campusBuildings.filter(b => b.name).map(b => [b.name.toLowerCase(), b]));
  let busy = false;

  // ------------------------------------------------------------------ rendering
  function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function markup(text) {
    const blocks = text.split(/```/);
    return blocks.map((blk, i) => {
      if (i % 2) return `<pre class="code">${esc(blk.replace(/^\n/, ''))}</pre>`;
      const lines = esc(blk).split('\n');
      let html = '', inList = false;
      for (const raw of lines) {
        const bullet = raw.startsWith('- ');
        if (bullet && !inList) { html += '<ul>'; inList = true; }
        if (!bullet && inList) { html += '</ul>'; inList = false; }
        let l = (bullet ? raw.slice(2) : raw)
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/`(.+?)`/g, '<code>$1</code>')
          .replace(/\{b:(.+?)\}/g, (_, n) => `<a class="ent" data-building="${n}">${n}</a>`);
        html += bullet ? `<li>${l}</li>` : (l.trim() ? `<p>${l}</p>` : '');
      }
      return html + (inList ? '</ul>' : '');
    }).join('');
  }

  function addMsg(role, html) {
    $('#assistant-empty')?.remove();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = role === 'user'
      ? `<span class="prompt">›</span><span>${html}</span><span class="ts">${new Date().toTimeString().slice(0, 8)}</span>`
      : html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // a short query status, then the result revealed line by line, like system output
  async function stream(text, actions = []) {
    const el = addMsg('bot', '<div class="querying"><span class="spin"></span>Querying dispatch results…</div>');
    await sleep(300 + Math.random() * 250);
    el.innerHTML = markup(text) + (actions.length
      ? `<div class="msg-actions">${actions.map((a, i) => `<button data-act="${i}">${a.label}</button>`).join('')}</div>` : '');
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => actions[+b.dataset.act].run()));
    const lines = [...el.querySelectorAll(':scope > p, :scope > ul > li, :scope > pre, :scope > .msg-actions')];
    lines.forEach(l => l.classList.add('rv'));
    for (const l of lines) {
      l.classList.add('in');
      log.scrollTop = log.scrollHeight;
      await sleep(55);
    }
  }

  log.addEventListener('click', e => {
    const a = e.target.closest('[data-building]');
    if (!a) return;
    const b = byName.get(a.dataset.building.toLowerCase());
    if (b) map.focusOn(b.cx, b.cy, 380);
  });

  // ------------------------------------------------------------------ helpers
  async function ensureMicrogrid(pid, opts = {}) {
    for (const [k, v] of Object.entries(opts)) mg.opts[k] = v;
    if (mg.mode === 'pick') mg.cancelPick();
    if (mg.active !== pid) await mg.create(pid);
    else mg.refresh();
    app.onMgChange?.();
  }
  const runOf = (d, day, grid, flex, evOn) => d.runs[`${day}|${grid}|${flex}|${d.ev ? evOn : 'noev'}`];
  function findBuilding(text) {
    const t = text.toLowerCase();
    let best = null;
    for (const [name, b] of byName) if (t.includes(name) && (!best || name.length > best[0].length)) best = [name, b];
    return best?.[1] ?? null;
  }
  function findTime(text) {
    const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (!m || (!m[2] && !m[3])) return null;
    let h = +m[1] % 24;
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    return Math.min(95, h * 4 + Math.floor((+(m[2] || 0)) / 15));
  }

  // ------------------------------------------------------------------ answers
  const A = {};

  A.campus = async () => {
    if (mg.active) mg.remove();
    map.setView?.('3d');
    map.resetView();
    const c = weather.days[app.state.day].campus, k = app.state.step;
    const pv = campus.pv, pub = ev.public;
    await stream(
`Campus status at **${hhmm(k)}**, ${weather.days[app.state.day].date}.
- **${map.campusBuildings.length} NUS buildings**, from OpenStreetMap, heights from storey counts where mapped
- **${(pv.total_kwp / 1000).toFixed(1)} MWp rooftop PV** on ${pv.buildings} roofs (${pv.documented} documented in NUS sources)
- **${ev.fleet.points} fleet EV chargers** (synthetic), plus ${pub.sites.length} documented public charging sites
- **40 weather stations**: now ${c.t_air[k].toFixed(1)} °C, feels like ${c.feels[k].toFixed(1)} °C, ${Math.round(c.ghi[k])} W/m² sun
Every asset (solar, storage, generators, EVs **and the buildings**) can publish itself to one dispatcher as the same object.`,
      [{ label: '⚡ Create a microgrid', run: () => ask('Create a microgrid for Engineering') }]);
  };

  A.microgrid = async (pid = 'engineering') => {
    await ensureMicrogrid(pid, { grid: 'normal', flex: 'flex' });
    const d = mg.data, der = d.der, day = app.state.day;
    const base = d.base[day].load, peak = Math.max(...base);
    const types = Object.values(d.archetype).reduce((o, a) => (o[a] = (o[a] || 0) + 1, o), {});
    await stream(
`**${d.name} microgrid** is up: ${der.buildings} buildings on one bus, peak demand **${kw(peak)}**.
- PV **${kw(der.pv_kwp)}p** on the precinct's roofs
- Battery **${kw(der.batt_kw)} / ${(der.batt_kwh / 1000).toFixed(1)} MWh** and genset **${kw(der.genset_kw)}** at the energy hub
- Buildings: ${Object.entries(types).map(([a, n]) => `${n} ${ARCH[a]}`).join(', ')}
The grid tie is closed, so the utility covers any gap. The battery and generator are a **hypothetical overlay**: NUS today has PV but no islanding capability.`,
      [{ label: '⚠ Fail the grid at 13:00', run: () => ask('The grid just failed at 13:00') }]);
  };

  A.outage = async () => {
    const pid = mg.active || 'engineering';
    await ensureMicrogrid(pid, { grid: 'outage', flex: 'flex' });
    app.setTime(app.state.day, 52);
    const d = mg.data, day = app.state.day, r = runOf(d, day, 'outage', 'flex', mg.opts.ev);
    const fixed = runOf(d, day, 'outage', 'fixed', mg.opts.ev).metrics, m = r.metrics;
    const floorK = r.soc.findIndex((s, k) => k >= 52 && s <= 10.5);
    const ids = Object.keys(r.buildings);
    const flexK = r.soc.findIndex((_, k) => k >= 52 &&
      ids.reduce((s, id) => s + d.base[day].buildings[id][k] - r.buildings[id].p[k], 0) > 50);
    const dropped = m.unserved_noncrit_kwh + m.unserved_crit_kwh;
    const droppedFixed = fixed.unserved_noncrit_kwh + fixed.unserved_crit_kwh;
    await stream(
`**13:00: the utility tie opens.** ${d.name} is now an island until 17:00, with no grid to absorb the gap. The dispatcher re-plans:
- **Genset** starts and runs at up to ${kw(d.der.genset_kw)}
- **Battery** discharges from ${r.soc[52].toFixed(0)}%${floorK > 0 ? ` and reaches its 10% floor at **${hhmm(floorK)}**` : ''}
- **Buildings** ease cooling${flexK > 0 ? ` from **${hhmm(flexK)}**` : ''}, drifting warm inside their comfort bands, then repay after 17:00
- **Critical load lost: ${n0(m.unserved_crit_kwh)} kWh.** Non-critical load dropped: ${n0(dropped)} kWh, versus **${n0(droppedFixed)} kWh** if the buildings were fixed loads
Every zone temperature was re-simulated on the cooling actually delivered: comfort violation **${m.comfort_violation_k.toFixed(2)} K**.`,
      [{ label: '▶ Play the outage', run: () => app.playFrom(52) },
       { label: 'What if buildings weren\'t flexible?', run: () => ask('What if the buildings weren\'t flexible?') }]);
  };

  A.fixed = async () => {
    const pid = mg.active || 'engineering';
    await ensureMicrogrid(pid, { grid: 'outage', flex: 'fixed' });
    const d = mg.data, day = app.state.day;
    const f = runOf(d, day, 'outage', 'fixed', mg.opts.ev).metrics, x = runOf(d, day, 'outage', 'flex', mg.opts.ev).metrics;
    const df = f.unserved_noncrit_kwh + f.unserved_crit_kwh, dx = x.unserved_noncrit_kwh + x.unserved_crit_kwh;
    await stream(
`With the buildings as **fixed loads**, the same outage drops **${n0(df)} kWh** of load (${f.load_shed_minutes} minutes of shedding, peak ${kw(f.peak_load_dropped_kw)}).
With the buildings **publishing their flexibility**, it drops **${n0(dx)} kWh**: **${Math.round(100 * (1 - dx / Math.max(df, 1)))}% less**, with zero comfort violation.
Same battery, same genset, same engine. The only change is that each building now tells the dispatcher how much cooling it can defer, and at what cost to repay.`,
      [{ label: 'Turn flexibility back on', run: () => { mg.setOpt('flex', 'flex'); app.onMgChange?.(); } },
       { label: 'What can SDE4 offer?', run: () => ask('What can SDE4 offer?') }]);
  };

  A.help = async (t = 15 * 4) => {
    const pid = mg.active || 'engineering';
    await ensureMicrogrid(pid, { grid: 'outage', flex: 'flex' });
    app.setTime(app.state.day, t);
    const d = mg.data, day = app.state.day, r = runOf(d, day, 'outage', 'flex', mg.opts.ev);
    const rows = Object.keys(r.buildings).map(id => {
      const b = map.campusBuildings.find(x => x.id === id);
      return { b, arch: d.archetype[id], cap: d.base[day].shed_max?.[id]?.[t] ?? 0,
               now: d.base[day].buildings[id][t] - r.buildings[id].p[t] };
    }).sort((a, b) => b.cap - a.cap);
    const top = rows.slice(0, 5);
    const labs = rows.filter(x => x.arch === 'lab');
    const labShare = labs.reduce((s, x) => s + x.cap, 0) / Math.max(1, rows.reduce((s, x) => s + x.cap, 0));
    await stream(
`At **${hhmm(t)}** in ${d.name}, the buildings with the most cooling they could defer:
${top.map(x => `- {b:${x.b.name || x.b.id}}: up to **${kw(x.cap)}** (${ARCH[x.arch]})${x.now > 1 ? `, easing ${kw(x.now)} now` : ''}`).join('\n')}
Together the precinct's buildings could ease **${kw(rows.reduce((s, x) => s + x.cap, 0))}** right now.${labs.length ? ` Research labs are ${labs.length} of ${rows.length} buildings but only ${Math.round(labShare * 100)}% of that: tight comfort bands, little to give.` : ''}
Buildings shown in **violet** on the map are easing cooling at this moment.`,
      [{ label: `What can ${top[0].b.name || 'the top building'} offer?`, run: () => ask(`What can ${top[0].b.name} offer?`) }]);
  };

  A.offer = async (b) => {
    const pid = app.precinctOfBuilding(b);
    if (!pid) {
      map.focusOn(b.cx, b.cy, 380);
      await stream(`{b:${b.name || b.id}} isn't inside one of the five modelled precincts, so it has no dispatch results yet. Try {b:SDE4}, {b:MD6} or {b:Central Library}.`);
      return;
    }
    const d = await mg.load(pid), day = app.state.day, k = app.state.step, e = d.envelope[b.id], arch = d.archetype[b.id];
    const base = d.base[day].buildings[b.id][k], shed = d.base[day].shed_max?.[b.id]?.[k] ?? 0;
    map.focusOn(b.cx, b.cy, 380);
    await stream(
`This is everything the dispatcher receives from **{b:${b.name}}** at ${hhmm(k)}, the same object shape as a battery:
\`\`\`
CapabilityOffer(
  asset_id   = "B_${b.id}"
  protocol   = "BMS / BACnet (simulated)"
  primitives = ["bounds", "recovery"]
  p_min_kw   = ${n0(-(base + (e.max_repay_kw ?? 0)))}  # repay
  p_max_kw   = ${n0(-(base - shed))}  # shed
  baseline   = ${n0(-base)}
  recovery   = Recovery(
    ratio             = ${e.recovery_ratio}
    window_steps      = ${e.window_steps}      # ${e.window_steps / 4} h
    window_energy_kwh = ${n0(e.window_energy_kwh)}
    max_repay_kw      = ${n0(e.max_repay_kw)} ))
\`\`\`
- **${ARCH[arch]}**, ${n0(e.gfa_m2)} m² floor area, comfort band ${e.setpoint_c}–${e.comfort_max_c} °C
- It can shed up to **${kw(shed)}** now (${Math.round(e.max_shed_frac * 100)}% of its cooling), but only **${n0(e.window_energy_kwh)} kWh** in total before the zone reaches ${e.comfort_max_c} °C
- Repaying costs **${e.recovery_ratio}×** what was saved: a zone coasting warm picks up extra heat
- Only the thermally accessible ${Math.round(e.accessible_mass_frac * 100)}% of the building's mass is counted
The dispatcher never sees a temperature. It sees bounds and a debt it must repay.`,
      [{ label: 'Which buildings can help at 15:00?', run: () => ask('Which buildings can help at 15:00?') }]);
  };

  A.ev = async () => {
    await ensureMicrogrid('engineering', { grid: 'outage', flex: 'flex', ev: 'ev' });
    const d = mg.data, day = app.state.day;
    const on = runOf(d, day, 'outage', 'flex', 'ev'), off = runOf(d, day, 'outage', 'flex', 'noev');
    const total = on.ev.reduce((s, x) => s + x, 0) * 0.25;
    const lastK = on.ev.reduce((last, x, k) => (x > 1 ? k : last), 0);
    await stream(
`**EV fleet registered**: 40 vehicles × 7 kW over OCPP 1.6J, at Carpark 1.
- Assets: **${off.metrics.assets} → ${on.metrics.assets}**. Engine lines changed: **0**
- It's a new kind of asset, a load with a hard 18:00 deadline, but it's described with a primitive the engine already has: \`storage\` with a state-of-charge floor that steps up at departure
- During the outage it charged **${n0(on.metrics.ev_charged_during_outage_kwh)} kWh**: it deferred on its own, then charged ${n0(total)} kWh in total, finishing by **${hhmm(lastK + 1)}**
Registering it was a new adapter, not a change to the dispatcher.`,
      [{ label: '▶ Play 12:00 → 19:00', run: () => app.playFrom(48) }]);
  };

  A.science = async () => {
    const d = await mg.load('science'), e = await mg.load('engineering'), day = app.state.day;
    const cut = x => {
      const f = runOf(x, day, 'outage', 'fixed', 'noev').metrics, g = runOf(x, day, 'outage', 'flex', 'noev').metrics;
      const a = f.unserved_noncrit_kwh + f.unserved_crit_kwh, b = g.unserved_noncrit_kwh + g.unserved_crit_kwh;
      return [a, b, Math.round(100 * (1 - b / Math.max(a, 1)))];
    };
    const [sa, sb, sp] = cut(d), [ea, eb, ep] = cut(e);
    const labs = Object.values(d.archetype).filter(a => a === 'lab').length;
    await ensureMicrogrid('science', { grid: 'outage', flex: 'flex' });
    await stream(
`Flexibility cuts dropped load by **${ep}%** in Engineering (${n0(ea)} → ${n0(eb)} kWh) but only **${sp}%** in Science & Medicine (${n0(sa)} → ${n0(sb)} kWh).
The reason is the buildings: **${labs} of ${Object.keys(d.archetype).length}** here are research labs.
- Comfort band of **1 K** (23–24 °C) versus 2 K for academic space
- They can shed only **15%** of cooling, versus 45%
- 70% of their load is **critical**, so it must never be dropped
Some buildings simply can't help much, and the capability object says so honestly. That's more credible than a campus where every building is generously flexible.`);
  };

  A.cloudy = async () => {
    app.setDay('cloudy');
    app.setLayer('sun');
    app.setTime('cloudy', 44);
    const c = weather.days.cloudy.campus;
    const noon = c.ghi.slice(40, 64), swing = Math.max(...noon) - Math.min(...noon);
    await stream(
`Switched to the **cloudy day** (${weather.days.cloudy.date}) with the pins showing **sunlight**. Between 10:00 and 16:00 campus irradiance swings by **${Math.round(swing)} W/m²** as clouds cross, and each PV roof glows with its nearest station's reading.
That's why the campus needs storage and a dispatcher: supply can halve in 15 minutes while the buildings still need cooling.`,
      [{ label: '▶ Play the day', run: () => app.playFrom(28) }]);
  };

  A.explain = async () => stream(
`**Storage** moves energy in time: a battery, an EV fleet that can wait, or a building coasting on its thermal mass.
The **dispatcher** decides every 15 minutes how much each asset does: generator, battery, buildings, EVs. It picks the cheapest plan that never breaks a hard limit (battery floor, comfort band, generator minimum load, critical load).
It's a mixed-integer linear program. It only ever sees **capability offers**, never device types or temperatures, and \`check_modularity.py\` proves the engine contains no asset-type logic.`);

  A.der = async () => stream(
`**DER = Distributed Energy Resources**: local assets on the campus network. Rooftop PV, batteries, gensets, EV chargers, and here **the buildings' flexible cooling**.
A **microgrid** is DERs plus loads, coordinated by a dispatcher, that can disconnect from the utility grid. NUS has DERs (PV) but no islanding capability, so it is **not** a microgrid today. The batteries and gensets here are a hypothetical overlay.`);

  A.scope = async () => stream(
`This layer is **supervisory**: it decides setpoints every 15 minutes.
Everything faster belongs to local controllers: protection, islanding detection, grid-forming inverters, frequency and voltage ride-through. They own that; this layer never claims otherwise.
Protocol adapters (SunSpec Modbus, BACnet, OCPP) are **designed** here but run against simulated devices.`);

  A.fallback = async () => stream(
`No matching query. Examples:
- "Create a microgrid for UTown"
- "The grid just failed at 13:00"
- "What can MD6 offer?"
- "Which buildings can help at 3pm?"
- "Show me a cloudy day"`);

  // ------------------------------------------------------------------ routing
  async function route(text) {
    const t = text.toLowerCase();
    const time = findTime(text);
    const b = findBuilding(text);
    const pid = PRECINCT_WORDS.find(([, rx]) => rx.test(text))?.[0];
    if (/what can|offer|capabilit|envelope/.test(t) && b) return A.offer(b);
    if (/which buildings|who can help|can help|most flexib|shed load/.test(t)) return A.help(time ?? 60);
    if (/\bev\b|electric vehicle|fleet|charg/.test(t)) return A.ev();
    if (/weren.?t flexible|not flexible|fixed load|without flex|no flex/.test(t)) return A.fixed();
    if (/outage|fail|grid (goes|went|is)? ?down|blackout|island|tie opens/.test(t)) return A.outage();
    if (/why.*science|science.*different|labs?\b.*(help|flex)/.test(t)) return A.science();
    if (/microgrid|precinct|create/.test(t)) return A.microgrid(pid || 'engineering');
    if (/cloud|rain|overcast/.test(t)) return A.cloudy();
    if (/\bder\b|distributed energy/.test(t)) return A.der();
    if (/below|protection|grid.?forming|scope|frequency|islanding transition/.test(t)) return A.scope();
    if (/dispatch|storage|how does|how it works/.test(t)) return A.explain();
    if (/campus|overview|show me|hello|hi\b|start/.test(t)) return A.campus();
    if (b) return A.offer(b);
    if (time != null) { app.setTime(app.state.day, time); return stream(`Clock set to **${hhmm(time)}**.`); }
    return A.fallback();
  }

  async function ask(text) {
    if (busy || !text.trim()) return;
    busy = true;
    form.classList.add('busy');
    addMsg('user', esc(text));
    try { await route(text); }
    catch (e) { console.error(e); await stream('Query failed. The map is unaffected.'); }
    finally { busy = false; form.classList.remove('busy'); input.focus(); }
  }

  // ------------------------------------------------------------------ wiring
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    ask(v);
  });
  document.querySelectorAll('[data-ask]').forEach(c => c.addEventListener('click', () => ask(c.dataset.ask)));
  $('#chat-suggest').addEventListener('click', e => {
    const c = e.target.closest('[data-ask]');
    if (c) ask(c.dataset.ask);
  });

  return { ask };
}
