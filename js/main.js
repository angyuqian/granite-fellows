import { createScene, rampColor, heightT, RAMP_MAX_M } from './scene.js';
import { fetchJSON } from './net.js';
import { addStations } from './stations.js';
import { addPV } from './pv.js';
import { addEV } from './ev.js';
import { createStationPopup } from './popup.js';
import { METRICS, compass } from './metrics.js';
import { createMicrogrids } from './microgrid.js';
import { createAssistant } from './assistant.js';
import { createConcept } from './concept.js';
import { createIdle } from './idle.js';

const $ = sel => document.querySelector(sel);
const fmt = n => n.toLocaleString('en-SG', { maximumFractionDigits: 0 });

const [campus, weather] = await Promise.all(
  ['data/campus.json', 'data/weather.json'].map(u => fetchJSON(u)));
const map = createScene($('#map'), campus);
const stations = addStations(map, weather);
const pv = addPV(map, campus);
const ev = addEV(map, campus, $('.map-wrap'));
const mg = await createMicrogrids(map, campus, $('.map-wrap'), {
  getTime: () => state, onChange: () => updateMgButton() });
$('#loading').classList.add('done');

// ---------------- panels ----------------
document.querySelectorAll('[data-toggle]').forEach(btn =>
  btn.addEventListener('click', () => $('#app').classList.toggle('hide-' + btn.dataset.toggle)));

// drag the inner edge of a side panel to resize it; double-click to reset
{
  const app = $('#app');
  const LIMITS = { left: [240, 560], right: [280, 640] };
  const KEY = 'mgo.panels';
  try {                                          // a remembered layout is a convenience only
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const side of ['left', 'right'])
      if (saved[side]) app.style.setProperty(`--${side}-w`, saved[side] + 'px');
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        left: parseInt(app.style.getPropertyValue('--left-w')) || undefined,
        right: parseInt(app.style.getPropertyValue('--right-w')) || undefined,
      }));
    } catch {}
  };
  document.querySelectorAll('.resizer').forEach(h => {
    const side = h.dataset.side, [lo, hi] = LIMITS[side];
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      app.classList.add('resizing');
      h.classList.add('active');
    });
    h.addEventListener('pointermove', e => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      const r = app.getBoundingClientRect();
      const w = side === 'left' ? e.clientX - r.left : r.right - e.clientX;
      app.style.setProperty(`--${side}-w`, Math.round(Math.min(Math.max(w, lo), hi)) + 'px');
    });
    const end = e => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      h.releasePointerCapture(e.pointerId);
      app.classList.remove('resizing');
      h.classList.remove('active');
      save();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => { app.style.removeProperty(`--${side}-w`); save(); });
  });
}

// ---------------- map controls ----------------
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b === btn));
  map.setView(btn.dataset.view);
}));
document.querySelectorAll('[data-zoom]').forEach(btn => btn.addEventListener('click', () => {
  const z = btn.dataset.zoom;
  if (z === 'reset') map.resetView(); else map.zoom(z === 'in' ? 0.7 : 1.4);
}));

// ---------------- hover tooltip ----------------
const tip = $('#tooltip');
const SRC = { 'osm:levels': 'OSM storeys', 'osm:height': 'OSM height', default: 'estimated' };
const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;
const val = (x, d, u) => x == null ? '<span class="est">no reading</span>' : `${x.toFixed(d)} ${u}`;

const ARCH = { academic: 'Academic', lab: 'Research lab', residential: 'Residential', assembly: 'Assembly' };
function buildingTip(b, i) {
  const m = mg.buildingInfo(i);
  const mgRows = !m ? '' : `<div class="mg-row">` + row('Type', ARCH[m.arch]) +
    row('Load now', `${fmt(m.p)} kW`) +
    row(m.base - m.p > 1 ? 'Easing cooling' : m.p - m.base > 1 ? 'Repaying' : 'vs baseline',
        `${m.base - m.p > 1 ? '−' : m.p - m.base > 1 ? '+' : ''}${fmt(Math.abs(m.base - m.p))} kW`) +
    row('Zone temp', `${m.t.toFixed(2)} °C <span class="est">limit ${m.env.comfort_max_c}</span>`) +
    (m.env.window_energy_kwh != null ? row('Envelope', `${fmt(m.env.window_energy_kwh)} kWh · ×${m.env.recovery_ratio}`) : '') +
    `</div>`;
  return `<b>${b.name || 'Unnamed building'}</b>` + mgRows +
    row('Height', `${b.h.toFixed(0)} m ${b.h_src === 'default' ? '<span class="est">est.</span>' : ''}`) +
    row('Footprint', `${fmt(b.area)} m²`) + row('OSM use', b.use) + row('Height from', SRC[b.h_src]) +
    (b.pv ? row('Rooftop PV', `${fmt(b.pv.kwp)} kWp · ${fmt(b.pv.panels)} panels`) +
      `<div class="pv-src ${b.pv.status}">${b.pv.status === 'documented' ? 'Documented' : 'Assumed site'}: ${b.pv.note}</div>` : '');
}
function evTip(s) {
  const ch = s.chargers ? s.chargers.map(c => `${c.n} × ${c.kw} kW ${c.type}`).join(' + ') : 'not published';
  if (s.kind === 'fleet')
    return `<b>EV fleet · ${s.name}</b>` + row('Vehicles', s.vehicles) + row('Chargers', ch) +
      row('Max draw', `${fmt(s.kw)} kW`) + row('Protocol', s.protocol) +
      `<div class="pv-src assumed">Synthetic: the managed fleet the dispatcher schedules</div>`;
  return `<b>Public EV charging · ${s.name}</b>` + row('Chargers', ch) +
    (s.kw ? row('Max draw', `${fmt(s.kw)} kW`) : '') + (s.operator ? row('Operator', s.operator) : '') +
    (s.underground ? row('Location', 'basement car park') : '') +
    `<div class="pv-src documented">Documented: ${s.note}</div>`;
}
function stationTip(r) {
  const s = r.station;
  return `<b>${s.id} · ${s.name}</b>` + row('Mount', s.mount) +
    row('Air temp', val(r.t_air, 1, '°C')) + row('Humidity', val(r.rh, 0, '%')) +
    row('Feels like', val(r.feels, 1, '°C')) + row('Sunlight', val(r.ghi, 0, 'W/m²')) +
    row('Wind', r.wind == null ? val(null) : `${r.wind.toFixed(1)} m/s from ${compass(r.wind_dir)}`);
}

let raf = 0, lastPointer = null;
function hover(e) {
  if (mg.mode === 'pick') {
    const pid = mg.hoverAt(e.clientX, e.clientY);
    map.canvas.style.cursor = pid ? 'pointer' : '';
    tip.hidden = true;
    return;
  }
  const si = stations.pick(e.clientX, e.clientY);          // pins sit above roofs: test first
  const ei = si < 0 ? ev.pick(e.clientX, e.clientY) : -1;
  const bi = si < 0 && ei < 0 ? map.pick(e.clientX, e.clientY) : -1;
  stations.setHover(si);
  ev.setHover(ei);
  map.setHover(bi);
  if (si < 0 && ei < 0 && bi < 0) { tip.hidden = true; map.canvas.style.cursor = ''; return; }
  map.canvas.style.cursor = 'pointer';
  tip.innerHTML = si >= 0 ? stationTip(stations.reading(si))
    : ei >= 0 ? evTip(ev.sites[ei]) : buildingTip(map.campusBuildings[bi], bi);
  const r = $('.map-wrap').getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(y + 14, r.height - tip.offsetHeight - 8) + 'px';
}
map.canvas.addEventListener('pointermove', e => {
  if (e.buttons) { stations.setHover(-1); ev.setHover(-1); map.setHover(-1); tip.hidden = true; return; }  // dragging
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => hover(lastPointer));
});
map.canvas.addEventListener('pointerleave', () => {
  lastPointer = null; stations.setHover(-1); ev.setHover(-1); map.setHover(-1); tip.hidden = true;
});

// ---------------- click: station pop-up ----------------
let popup;                                   // created once state exists, below
let down = null;
map.canvas.addEventListener('pointerdown', e => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
map.canvas.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;   // was a pan
  if (mg.mode === 'pick') {
    const pid = mg.pickAt(e.clientX, e.clientY);
    if (pid) mg.create(pid);
    return;
  }
  const si = stations.pick(e.clientX, e.clientY);
  if (si >= 0) { popup.open(si); tip.hidden = true; }
  else popup.close();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (mg.mode === 'pick') mg.cancelPick(); else popup.close();
});

// ---------------- create microgrid ----------------
function updateMgButton() {
  const m = mg.mode;
  $('#mg-btn').className = `mg-btn ${m === 'idle' ? '' : m}`;
  $('#mg-btn-text').textContent = m === 'pick' ? 'Cancel' : m === 'active' ? 'Remove microgrid' : 'Create microgrid';
  $('#mg-hint').hidden = m !== 'pick';
  $('#legend').hidden = m === 'pick';                // keep the precinct labels clear
  if (m === 'active') $('.widgets').scrollTop = 0;
}
$('#mg-btn').addEventListener('click', () => {
  if (mg.mode === 'pick') mg.cancelPick();
  else if (mg.mode === 'active') mg.remove();
  else mg.startPick();
});

// ---------------- time: day + step drive every time-varying layer ----------------
const DAYS = Object.keys(weather.days);                        // ['demo', 'cloudy']
const DAY_LABEL = { demo: 'Demo day', cloudy: 'Cloudy' };
const START_STEP = 52;                                           // 13:00, when the outage begins
const state = { day: DAYS[0], step: START_STEP };
popup = createStationPopup(map, stations, weather, () => state, $('.map-wrap'));
const hhmm = k => `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`;
const dateLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });

$('#day-seg').innerHTML = DAYS.map(d =>
  `<button data-day="${d}">${DAY_LABEL[d] || d} · ${dateLabel(weather.days[d].date)}</button>`).join('');
$('#day-seg').addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (b) setTime(b.dataset.day, state.step);
});
$('#scrub').addEventListener('input', e => setTime(state.day, +e.target.value));

let timer = 0;
$('#play').addEventListener('click', () => {
  const on = !timer;
  $('#play').classList.toggle('on', on);
  if (on) timer = setInterval(() => setTime(state.day, (state.step + 1) % 96), 220);
  else { clearInterval(timer); timer = 0; }
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input[type=text]')) return;
  if (e.key === 'ArrowRight') setTime(state.day, Math.min(state.step + 1, 95));
  if (e.key === 'ArrowLeft') setTime(state.day, Math.max(state.step - 1, 0));
  if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
});

function setTime(day, step) {
  Object.assign(state, { day, step });
  $('#scrub').value = step;
  $('#clock').textContent = hhmm(step);
  document.querySelectorAll('[data-day]').forEach(b => b.setAttribute('aria-pressed', b.dataset.day === day));
  stations.setTime(day, step);
  renderLegend();
  renderWeather();
  mg.refresh();
  // each roof at its nearest station's irradiance; 0.8 performance ratio for
  // inverter, temperature and soiling losses
  const kw = pv.setIrradiance(b => stations.nearestValue(b.cx, b.cy, 'ghi'));
  $('#pv-now').textContent = `${(kw * 0.8 / 1000).toFixed(2)} MW`;
  popup.update();
  if (lastPointer) hover(lastPointer);                            // keep an open tooltip live
}

// ---------------- weather layer switcher ----------------
function renderLegend() {
  const M = METRICS[stations.metric], [lo, hi] = stations.range;
  $('#lg-mlabel').textContent = M.label;
  $('#lg-ramp').style.background = `linear-gradient(90deg,${M.stops.join(',')})`;
  $('#lg-tlo').textContent = lo.toFixed(M.d);
  $('#lg-tmid').textContent = ((lo + hi) / 2).toFixed(M.d);
  $('#lg-thi').textContent = `${hi.toFixed(M.d)} ${M.unit}`;
  const c = weather.days[state.day].campus, k = state.step;
  $('#wind-note').textContent = c.wind[k] == null ? '' :
    `campus ${c.wind[k].toFixed(1)} m/s from ${compass(c.wind_dir[k])}`;
}
$('#metric-seg').addEventListener('click', e => {
  const b = e.target.closest('[data-metric]');
  if (!b) return;
  document.querySelectorAll('[data-metric]').forEach(x => x.setAttribute('aria-pressed', x === b));
  stations.setMetric(b.dataset.metric);
  renderLegend();
  if (lastPointer) hover(lastPointer);
});
$('#wind-toggle').addEventListener('change', e => stations.setWind(e.target.checked));

// ---------------- weather card ----------------
function renderWeather() {
  const d = weather.days[state.day], c = d.campus, k = state.step;
  const n = Object.values(d.stations).filter(s => s.t_air[k] != null).length;
  $('#wx-when').textContent = `${dateLabel(d.date)} ${hhmm(k)}`;
  $('#wx-t').textContent = c.t_air[k]?.toFixed(1) ?? '—';
  $('#wx-rh').textContent = c.rh[k]?.toFixed(0) ?? '—';
  $('#wx-feels').textContent = c.feels[k]?.toFixed(1) ?? '—';
  $('#wx-dir').textContent = `m/s wind ${compass(c.wind_dir[k])}`;
  $('#wx-ghi').textContent = c.ghi[k]?.toFixed(0) ?? '—';
  $('#wx-wind').textContent = c.wind[k]?.toFixed(1) ?? '—';
  $('#wx-note').textContent = `Median of ${n} reporting stations · NUS campus network, 2025`;

  // sunlight as an area (fixed 0-1100 W/m², so the two days compare honestly),
  // air temperature as a line on its own 24-36 °C scale, and a cursor at now
  const W = 300, H = 64, x = i => (i / 95) * W;
  const yG = v => H - (v / 1100) * (H - 4);
  const yT = v => H - ((v - 24) / 12) * (H - 4);
  const pts = (arr, y) => arr.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean);
  const g = pts(c.ghi, yG), t = pts(c.t_air, yT);
  $('#wx-spark').innerHTML = `
    <path d="M0,${H} L${g.join(' L')} L${W},${H} Z" fill="var(--s-pv)" fill-opacity=".28" stroke="var(--s-pv)" stroke-width="1.2"/>
    <path d="M${t.join(' L')}" fill="none" stroke="#e06a58" stroke-width="1.5"/>
    <line x1="${x(k)}" x2="${x(k)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="1.2"/>`;
}

// ---------------- widgets ----------------
$('#pv-kwp').textContent = (campus.pv.total_kwp / 1000).toFixed(1);
$('#pv-sub').textContent = `${fmt(pv.count)} panels on ${campus.pv.buildings} buildings · ` +
  `${campus.pv.documented} documented`;
$('#pv-ref').href = campus.pv.published.ref;
$('#ev-n').textContent = ev.fleet.points;
$('#ev-sub').textContent = ev.fleet.sites.map(s => `${s.name} · ${s.vehicles} × ${s.chargers[0].kw} kW`).join(' · ') +
  ` · ${fmt(ev.fleet.kw)} kW max`;
$('#ev-pub').innerHTML = ev.public.sites.map(s =>
  `<li><a href="${s.ref}" target="_blank" rel="noopener">${s.name}</a>
     <span>${s.chargers ? s.chargers.map(c => `${c.n}×${c.kw} ${c.type}`).join(' + ') : 'count n/a'}</span></li>`).join('');

const B = map.campusBuildings;
const storeys = b => Math.max(1, Math.round(b.h / 4));
$('#w-count').textContent = fmt(B.length);
$('#w-count-sub').textContent = 'Excludes covered walkways, NUH blocks and structures under 150 m²';
$('#w-height').textContent = (B.reduce((s, b) => s + b.h, 0) / B.length).toFixed(1);
const gfa = B.reduce((s, b) => s + b.area * storeys(b), 0);
$('#w-gfa').textContent = gfa >= 1e6 ? (gfa / 1e6).toFixed(2) + ' M' : fmt(gfa);

// histogram, 4 m bins to 80+, bars in the height ramp
{
  const BIN = 4, N = RAMP_MAX_M / BIN;
  const bins = new Array(N).fill(0);
  B.forEach(b => bins[Math.min(Math.floor(b.h / BIN), N - 1)]++);
  const max = Math.max(...bins), W = 300, H = 120, bw = W / N;
  $('#w-hist').innerHTML = bins.map((c, i) => {
    const h = (c / max) * (H - 4);
    return `<rect x="${i * bw + 1}" y="${H - h}" width="${bw - 2}" height="${h}" rx="1.5"
      fill="#${rampColor(heightT((i + 0.5) * BIN)).getHexString()}"><title>${i * BIN}–${(i + 1) * BIN} m: ${c}</title></rect>`;
  }).join('');
}

// height provenance: honest about what is guessed
{
  const parts = [
    ['osm:height', 'OSM height', 'var(--ok)'],
    ['osm:levels', 'OSM storey count', 'var(--s-grid)'],
    ['default', 'Estimated from use', 'var(--warn)'],
  ].map(([k, label, color]) => ({ label, color, n: B.filter(b => b.h_src === k).length }))
   .filter(p => p.n);
  $('#w-src').outerHTML = `<div class="stack">${parts.map(p =>
      `<span style="flex:${p.n};background:${p.color}"></span>`).join('')}</div>
    <div class="stack-legend">${parts.map(p =>
      `<div><i style="background:${p.color}"></i>${p.label}<b>${p.n}</b></div>`).join('')}</div>`;
}



// ---------------- assistant ----------------
const memberOf = new Map(mg.index.flatMap(p => p.members.map(id => [id, p.id])));
const assistant = createAssistant({
  map, mg, campus, weather, stations, ev, state,
  setTime,
  setDay: d => setTime(d, state.step),
  setLayer: k => document.querySelector(`[data-metric="${k}"]`)?.click(),
  playFrom: k => {
    setTime(state.day, k);
    if (!timer) $('#play').click();
  },
  precinctOfBuilding: b => memberOf.get(b.id) || null,
  onMgChange: () => updateMgButton(),
});

// ---------------- how it works ----------------
const concept = createConcept(q => assistant.ask(q));
$('#info-btn').addEventListener('click', () => concept.open());

// ---------------- ambient motion: idle orbit + attract mode ----------------
const idle = createIdle(map, { getTime: () => state, setTime, days: DAYS,
  onAttractEnd: () => setTime(DAYS[0], START_STEP) });

// deep links for rehearsal and screenshots:
//   #2d  #station=WS06  #t=13:30  #day=cloudy  #focus=SDE4  #layer=sun  #wind=1
{
  const h = new URLSearchParams(location.hash.slice(1).replace(/^2d/, 'view=2d'));
  if (h.get('view') === '2d') document.querySelector('[data-view="2d"]').click();
  const layer = document.querySelector(`[data-metric="${h.get('layer')}"]`);
  if (layer) layer.click();
  if (h.get('wind') === '1') { $('#wind-toggle').checked = true; stations.setWind(true); }
  for (const k of ['grid', 'flex', 'ev']) if (h.get(k)) mg.opts[k] = h.get(k);
  const t = h.get('t')?.match(/^(\d{1,2}):(\d{2})$/);
  const day = DAYS.includes(h.get('day')) ? h.get('day') : state.day;
  setTime(day, t ? Math.min(95, +t[1] * 4 + Math.floor(+t[2] / 15)) : state.step);
  const si = stations.stations.findIndex(s => s.id === h.get('station'));
  if (si >= 0) popup.open(si);
  // the public site greets visitors with attract mode, unless the link asks for a view;
  // on localhost (the pitch laptop) it only starts on request
  const publicSite = location.hostname.endsWith('github.io');
  if (h.get('attract') === '1' || (publicSite && !location.hash)) idle.startAttract();
  if (h.get('concept')) concept.open(Math.max(0, +h.get('concept') - 1));
  if (h.get('ask')) await assistant.ask(h.get('ask'));
  if (h.get('mg')) await mg.create(h.get('mg'));
  else if (h.get('pick')) mg.startPick();
  const fb = map.campusBuildings.find(b => b.name === h.get('focus'));
  if (fb) map.focusOn(fb.cx, fb.cy, +h.get('dist') || 420);
  console.log(`PV: ${pv.count} panels on ${pv.roofs} roofs, ${pv.unplaced} did not fit`);
}
