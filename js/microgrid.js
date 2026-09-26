// "Create a microgrid": pick a precinct, and it comes alive — an energy hub
// (battery + genset), the utility tie, feeders to every building, and flows
// whose speed and density follow the dispatch at the scrubber time.
//
// Every combination the controls can reach was solved offline by sim/energy.py
// with the same MILP as the prototype; this file only replays it.

import * as THREE from 'three';
import { fetchJSON } from './net.js';

export const MG = {
  pv: '#f5b400', batt: '#22d3ee', gen: '#f97316', grid: '#94a3b8', ev: '#22c55e',
  load: '#e3e8ec', flex: '#9085e9', repay: '#a5f3fc', drop: '#ef4444',
};
const PARTICLES_PER_PATH = 7;
const REF_DIST = 2600;
const hhmm = k => `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`;
const fmtKW = kw => Math.abs(kw) >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${Math.round(kw)} kW`;

function flatShape(poly) {
  const s = new THREE.Shape();
  s.moveTo(poly[0], poly[1]);
  for (let i = 2; i < poly.length; i += 2) s.lineTo(poly[i], poly[i + 1]);
  return s;
}
function outline(poly, y, color, opacity = 1) {
  const pts = [];
  for (let i = 0; i < poly.length; i += 2) pts.push(new THREE.Vector3(poly[i], y, -poly[i + 1]));
  pts.push(pts[0].clone());
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
function htmlLabel(container, cls, html) {
  const el = document.createElement('div');
  el.className = `mg-label ${cls}`;
  el.innerHTML = html;
  container.appendChild(el);
  return el;
}
function placeLabel(el, world, camera, container) {
  const v = world.clone().project(camera);
  el.style.display = v.z > 1 ? 'none' : '';
  el.style.left = ((v.x + 1) / 2 * container.clientWidth) + 'px';
  el.style.top = ((1 - v.y) / 2 * container.clientHeight) + 'px';
}

export async function createMicrogrids(map, campus, container, { getTime, onChange }) {
  const index = await fetchJSON('data/mg/index.json');
  const bIndex = new Map(map.campusBuildings.map((b, i) => [b.id, i]));
  const cache = new Map();
  let mode = 'idle', active = null, hoverPid = null;
  // a new microgrid starts grid-connected; the outage is something the presenter
  // triggers (dashboard switch, or the console's "The grid just failed at 13:00")
  const opts = { grid: 'normal', flex: 'flex', ev: 'noev' };

  // ======================= pick mode =======================
  const pickGroup = new THREE.Group();
  pickGroup.visible = false;
  map.scene.add(pickGroup);
  const pickMeshes = [], pickLabels = [];
  for (const p of index.precincts) {
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(flatShape(p.hull)).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x35d6e0, transparent: true, opacity: 0.1, depthWrite: false }));
    fill.position.y = 0.6;
    fill.userData.pid = p.id;
    pickGroup.add(fill, outline(p.hull, 0.8, 0x35d6e0, 0.8));
    pickMeshes.push(fill);
    const el = htmlLabel(container, 'pick', `<b>${p.name}</b><span>${p.buildings} buildings · ${p.der.pv_kwp ? Math.round(p.der.pv_kwp) + ' kWp PV' : 'no PV'}</span>`);
    el.style.display = 'none';
    pickLabels.push({ el, p });
  }

  function startPick() {
    if (active) remove();
    mode = 'pick';
    pickGroup.visible = true;
    pickLabels.forEach(l => (l.el.style.display = ''));
    onChange?.();
  }
  function cancelPick() {
    mode = active ? 'active' : 'idle';
    pickGroup.visible = false;
    pickLabels.forEach(l => (l.el.style.display = 'none'));
    hoverPid = null;
    onChange?.();
  }
  function pickAt(clientX, clientY) {
    const hit = map.rayAt(clientX, clientY).intersectObjects(pickMeshes, false)[0];
    return hit ? hit.object.userData.pid : null;
  }
  function hoverAt(clientX, clientY) {
    hoverPid = pickAt(clientX, clientY);
    pickMeshes.forEach(m => (m.material.opacity = m.userData.pid === hoverPid ? 0.32 : 0.1));
    return hoverPid;
  }

  // ======================= active microgrid =======================
  async function load(pid) {
    if (!cache.has(pid)) cache.set(pid, await fetchJSON(`data/mg/${pid}.json`));
    return cache.get(pid);
  }
  function setOpt(k, v) {
    opts[k] = v;
    refresh();
    onChange?.();
  }
  async function create(pid, overrides = {}) {
    Object.assign(opts, overrides);
    if (active?.d.id === pid) return;
    if (active) remove();
    cancelPick();
    const d = await load(pid);
    if (!d.ev) opts.ev = 'noev';
    const g = new THREE.Group();
    map.scene.add(g);

    const members = Object.keys(d.archetype).filter(id => bIndex.has(id));
    const memberIdx = new Set(members.map(id => bIndex.get(id)));
    const hub = new THREE.Vector3(d.hub[0], 0, -d.hub[1]);
    const tie = new THREE.Vector3(d.tie[0], 0, -d.tie[1]);

    // precinct boundary
    g.add(outline(d.hull, 1.0, 0x35d6e0));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(flatShape(d.hull)).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x35d6e0, transparent: true, opacity: 0.05, depthWrite: false }));
    fill.position.y = 0.7;
    g.add(fill);

    // energy hub: plinth, battery racks, genset
    const hubG = new THREE.Group();
    hubG.position.copy(hub);
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(26, 28, 2, 40),
      new THREE.MeshLambertMaterial({ color: 0x1b2129 }));
    plinth.position.y = 1;
    const battMat = new THREE.MeshLambertMaterial({ color: 0x0e7490, emissive: MG.batt, emissiveIntensity: 0.4 });
    for (let i = 0; i < 4; i++) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(5, 7, 12), battMat);
      rack.position.set(-12 + i * 6.5, 5.5, -4);
      hubG.add(rack);
    }
    const genMat = new THREE.MeshLambertMaterial({ color: 0x7c2d12, emissive: MG.gen, emissiveIntensity: 0.1 });
    const gen = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 8), genMat);
    gen.position.set(6, 6, 12);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 8, 12), genMat);
    stack.position.set(12, 14, 12);
    hubG.add(plinth, gen, stack);
    g.add(hubG);

    // utility tie: a small substation
    const tieMat = new THREE.MeshLambertMaterial({ color: 0x475569, emissive: MG.grid, emissiveIntensity: 0.25 });
    const tieM = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), tieMat);
    tieM.position.copy(tie).setY(5);
    g.add(tieM);

    // ---- feeder paths: quadratic arcs, hub -> building roof (and tie -> hub, hub -> EV)
    const paths = [];
    function addPath(kind, from, fromH, to, toH, ref) {
      const dist = from.distanceTo(to);
      paths.push({ kind, from, to, fromH, toH, lift: 18 + dist * 0.18, ref });
    }
    members.forEach(id => {
      const b = map.campusBuildings[bIndex.get(id)];
      addPath('bldg', hub, 10, new THREE.Vector3(b.cx, 0, -b.cy), b.h + 2, id);
    });
    addPath('grid', tie, 10, hub, 10, 'grid');
    const evSite = (campus.ev || []).find(s => s.kind === 'fleet');
    if (d.ev && evSite) addPath('ev', hub, 10, new THREE.Vector3(evSite.cx, 0, -evSite.cy), 3, 'ev');

    const SEG = 20;
    const lineGeo = new THREE.BufferGeometry();
    const linePos = new Float32Array(paths.length * SEG * 6);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    const lineCol = new Float32Array(paths.length * SEG * 6);
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
    const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55 }));
    g.add(lines);

    const tmpV = new THREE.Vector3(), c = new THREE.Color();
    function pointOn(pth, t, flat, out) {       // quadratic bezier, heights squashed in 2D
      const y0 = pth.fromH * flat + 1, y1 = pth.toH * flat + 1;
      const mx = (pth.from.x + pth.to.x) / 2, mz = (pth.from.z + pth.to.z) / 2;
      const my = (y0 + y1) / 2 + pth.lift * (0.15 + 0.85 * flat);
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, cc = t * t;
      return out.set(a * pth.from.x + b * mx + cc * pth.to.x, a * y0 + b * my + cc * y1,
                     a * pth.from.z + b * mz + cc * pth.to.z);
    }
    let lastFlat = -1;
    function layoutLines(flat) {
      paths.forEach((pth, pi) => {
        for (let s = 0; s < SEG; s++) {
          pointOn(pth, s / SEG, flat, tmpV);
          linePos.set([tmpV.x, tmpV.y, tmpV.z], (pi * SEG + s) * 6);
          pointOn(pth, (s + 1) / SEG, flat, tmpV);
          linePos.set([tmpV.x, tmpV.y, tmpV.z], (pi * SEG + s) * 6 + 3);
        }
      });
      lineGeo.attributes.position.needsUpdate = true;
    }

    // ---- particles: one pool; each path owns PARTICLES_PER_PATH per stream
    const streams = [];                 // { path, color, dir, power(), ref }
    const particles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
      paths.length * PARTICLES_PER_PATH * 2);
    particles.frustumCulled = false;
    g.add(particles);

    // ---- labels
    const lbHub = htmlLabel(container, 'hub', '');
    const lbTie = htmlLabel(container, 'tie', '');
    const lbName = htmlLabel(container, 'name', `<b>${d.name}</b> microgrid`);
    const hullTop = (() => {                     // label at the hull's northernmost point
      let best = 0;
      for (let i = 1; i < d.hull.length; i += 2) if (d.hull[i] > d.hull[best * 2 + 1]) best = (i - 1) / 2;
      return new THREE.Vector3(d.hull[best * 2], 0, -d.hull[best * 2 + 1]);
    })();

    active = { d, g, paths, streams, particles, members, memberIdx, lineCol, lineGeo, lines, battMat, genMat,
               tieMat, labels: [lbHub, lbTie, lbName], hub, tie, hullTop, lbHub, lbTie, lbName,
               phase: new Float32Array(particles.count).map(() => Math.random()),
               grow: 0, t0: performance.now(), layoutLines, pointOn, lastFlat: -1 };
    mode = 'active';
    buildStreams();
    refresh();
    onChange?.();
    map.focusOn(d.hub[0], d.hub[1], 1150);
  }

  function run() {
    const a = active, { day } = getTime();
    return a.d.runs[`${day}|${opts.grid}|${opts.flex}|${a.d.ev ? opts.ev : 'noev'}`];
  }

  function buildStreams() {
    const a = active;
    a.streams.length = 0;
    const kwp = a.d.der.pv_kwp || 0;
    a.paths.forEach((pth, pi) => {
      if (pth.kind === 'bldg') {
        a.streams.push({ pi, color: new THREE.Color(MG.load), dir: 1,
          power: (r, k) => Math.max(0, r.buildings[pth.ref].p[k]) });
        const b = map.campusBuildings[bIndex.get(pth.ref)];
        if (b.pv && kwp) a.streams.push({ pi, color: new THREE.Color(MG.pv), dir: -1,
          power: (r, k) => Math.max(0, r.supply.PV[k]) * b.pv.kwp / kwp });
      } else if (pth.kind === 'grid') {
        a.streams.push({ pi, color: new THREE.Color(MG.grid), dir: 1, power: (r, k) => Math.max(0, r.supply.Grid[k]) });
      } else if (pth.kind === 'ev') {
        a.streams.push({ pi, color: new THREE.Color(MG.ev), dir: 1, power: (r, k) => (r.ev ? Math.max(0, r.ev[k]) : 0) });
      }
    });
    // per-stream reference power: its maximum over every run of this precinct
    for (const s of a.streams) {
      let ref = 1;
      for (const r of Object.values(a.d.runs)) for (let k = 0; k < 96; k++) ref = Math.max(ref, s.power(r, k));
      s.ref = ref;
    }
    let k = 0;
    for (const s of a.streams) {
      s.first = k; k += PARTICLES_PER_PATH;
      for (let j = 0; j < PARTICLES_PER_PATH; j++) a.particles.setColorAt(s.first + j, s.color);
    }
    a.particles.count = k;
    a.particles.instanceColor.needsUpdate = true;
  }

  // ---- per-step state: building colours, hub/tie look, labels, dashboard
  const COL = Object.fromEntries(Object.entries(MG).map(([k, v]) => [k, new THREE.Color(v)]));
  function refresh() {
    if (!active) return;
    const a = active, r = run(), { day, step: k } = getTime();
    const base = a.d.base[day];
    const env = a.d.envelope;

    // share of involuntary shedding by non-critical load (display allocation)
    const nc = a.members.map(id => base.buildings[id][k] * (1 - env[id].critical_frac));
    const ncSum = nc.reduce((s, x) => s + x, 0) || 1;
    const drop = r.unserved[k] - r.unserved_crit[k];

    const colorOf = new Map();
    a.members.forEach((id, j) => {
      const i = bIndex.get(id), b0 = base.buildings[id][k], p = r.buildings[id].p[k];
      const dropped = drop * nc[j] / ncSum;
      const col = new THREE.Color();
      if (dropped > 1) col.copy(COL.drop);
      else if (b0 - p > 0.02 * b0) col.copy(COL.flex).lerp(COL.load, 0.5 - 0.5 * Math.min(1, (b0 - p) / (0.3 * b0)));
      else if (p - b0 > 0.02 * b0) col.copy(COL.repay).lerp(COL.load, 0.5 - 0.5 * Math.min(1, (p - b0) / (0.3 * b0)));
      else col.copy(COL.load).multiplyScalar(0.72);
      colorOf.set(i, col);
    });
    map.setColors(i => colorOf.get(i) || null, 0.7);

    // line colours: grid feeder red while the tie is open
    const outage = r.supply.Grid[k] === 0 && opts.grid === 'outage' &&
      k >= a.d.outage[0] * 4 && k < a.d.outage[1] * 4;
    a.paths.forEach((pth, pi) => {
      const cc = pth.kind === 'grid' ? (outage ? COL.drop : COL.grid) : pth.kind === 'ev' ? COL.ev : COL.batt;
      for (let s = 0; s < 20 * 2; s++) a.lineCol.set([cc.r, cc.g, cc.b], (pi * 20 * 2 + s) * 3);
    });
    a.lineGeo.attributes.color.needsUpdate = true;

    const bess = r.supply.BESS[k], gen = r.supply.Genset[k];
    a.battMat.emissiveIntensity = 0.25 + 0.9 * Math.min(1, Math.abs(bess) / a.d.der.batt_kw);
    a.genMat.emissiveIntensity = 0.1 + 1.1 * Math.min(1, gen / a.d.der.genset_kw);
    a.tieMat.emissive.set(outage ? MG.drop : MG.grid);
    a.lbHub.innerHTML = `<b>Energy hub</b>
      <span class="batt">▮ ${r.soc[k].toFixed(0)}% ${bess > 1 ? '▼ ' + fmtKW(bess) : bess < -1 ? '▲ ' + fmtKW(-bess) : 'idle'}</span>
      <span class="gen">⚙ ${gen > 1 ? fmtKW(gen) : 'off'}</span>`;
    a.lbTie.innerHTML = outage ? `<b>Grid tie</b><span class="open">OPEN · outage</span>`
      : `<b>Grid tie</b><span>${r.supply.Grid[k] > 1 ? '▼ ' + fmtKW(r.supply.Grid[k]) : 'closed'}</span>`;
    a.lbTie.classList.toggle('alarm', outage);
    renderDashboard(r, k);
  }

  // ---- per-frame: particles, lines on flatten, labels, grow-in
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv3 = new THREE.Vector3(), sc3 = new THREE.Vector3();
  let lastNow = performance.now();
  map.onFrame(now => {
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    if (mode === 'pick') {
      pickLabels.forEach(({ el, p }) => {
        let cx = 0, cy = 0;
        for (let i = 0; i < p.hull.length; i += 2) { cx += p.hull[i]; cy += p.hull[i + 1]; }
        const n = p.hull.length / 2;
        placeLabel(el, new THREE.Vector3(cx / n, 60 * map.flat + 5, -cy / n), map.camera, container);
        el.classList.toggle('hot', p.id === hoverPid);
      });
    }
    if (!active) return;
    const a = active, flat = map.flat;
    if (Math.abs(flat - a.lastFlat) > 1e-4) { a.layoutLines(flat); a.lastFlat = flat; }
    a.grow = Math.min(1, (now - a.t0) / 1400);
    const r = run(), { step: k } = getTime();
    const size = 3.2 * map.camera.position.distanceTo(map.controls.target) / REF_DIST;
    for (const s of a.streams) {
      const pth = a.paths[s.pi], pw = s.power(r, k), f = Math.min(1, pw / s.ref);
      const nOn = pw < 0.5 ? 0 : Math.max(1, Math.round(PARTICLES_PER_PATH * Math.sqrt(f)));
      const speed = 0.12 + 0.55 * Math.sqrt(f);
      for (let j = 0; j < PARTICLES_PER_PATH; j++) {
        const id = s.first + j;
        a.phase[id] = (a.phase[id] + dt * speed) % 1;
        if (j >= nOn || a.grow < 1) { a.particles.setMatrixAt(id, m4.makeScale(0, 0, 0)); continue; }
        const t = (a.phase[id] + j / PARTICLES_PER_PATH) % 1;
        a.pointOn(pth, s.dir > 0 ? t : 1 - t, flat, pv3);
        a.particles.setMatrixAt(id, m4.compose(pv3, q, sc3.setScalar(size * (0.7 + 0.6 * Math.sqrt(f)))));
      }
    }
    a.particles.instanceMatrix.needsUpdate = true;
    a.lines.material.opacity = 0.55 * a.grow;
    placeLabel(a.lbHub, a.hub.clone().setY(40 * flat + 12), map.camera, container);
    placeLabel(a.lbTie, a.tie.clone().setY(22 * flat + 8), map.camera, container);
    placeLabel(a.lbName, a.hullTop.clone().setY(8), map.camera, container);
  });

  function remove() {
    if (!active) return;
    map.scene.remove(active.g);
    active.labels.forEach(el => el.remove());
    active = null;
    mode = 'idle';
    map.setColors(null);
    dash.hidden = true;
    onChange?.();
  }

  // ======================= dashboard =======================
  const dash = document.getElementById('mg-card');
  dash.addEventListener('click', e => {
    const b = e.target.closest('[data-opt]');
    if (b) { setOpt(b.dataset.opt, b.dataset.val); return; }
    if (e.target.closest('[data-mg-remove]')) remove();
  });

  function seg(opt, choices) {
    return `<div class="seg mini" role="group">${choices.map(([val, label]) =>
      `<button data-opt="${opt}" data-val="${val}" aria-pressed="${opts[opt] === val}">${label}</button>`).join('')}</div>`;
  }

  function renderDashboard(r, k) {
    const a = active, d = a.d, m = r.metrics, { day } = getTime();
    const other = d.runs[`${day}|${opts.grid}|${opts.flex === 'flex' ? 'fixed' : 'flex'}|${d.ev ? opts.ev : 'noev'}`].metrics;
    const dropped = m.unserved_noncrit_kwh + m.unserved_crit_kwh;
    const droppedOther = other.unserved_noncrit_kwh + other.unserved_crit_kwh;
    const cmp = opts.flex === 'flex' && droppedOther > 1
      ? `<span class="good">−${Math.round(100 * (1 - dropped / droppedOther))}% vs fixed buildings</span>`
      : opts.flex === 'fixed' && dropped > 1 ? `<span class="bad">flexibility would cut this to ${Math.round(droppedOther)}</span>` : '';

    const bess = r.supply.BESS[k];
    const flexNow = a.members.reduce((s, id) => s + d.base[day].buildings[id][k] - r.buildings[id].p[k], 0);
    dash.hidden = false;
    dash.innerHTML = `
      <div class="mg-head">
        <div><h2>${d.name} microgrid</h2>
          <p class="unit">${d.der.buildings} buildings · PV ${fmtKW(d.der.pv_kwp)}p · battery ${fmtKW(d.der.batt_kw)} / ${(d.der.batt_kwh / 1000).toFixed(1)} MWh · genset ${fmtKW(d.der.genset_kw)}</p></div>
        <button class="popup-close" data-mg-remove title="Remove microgrid" aria-label="Remove microgrid">×</button>
      </div>
      <div class="mg-ctrl">
        <span>Grid</span>${seg('grid', [['normal', 'Connected'], ['outage', `Outage ${d.outage[0]}:00–${d.outage[1]}:00`]])}
        <span>Buildings</span>${seg('flex', [['fixed', 'Fixed load'], ['flex', 'Flexible']])}
        ${d.ev ? `<span>EV fleet</span>${seg('ev', [['noev', 'Not registered'], ['ev', '+ Registered']])}` : ''}
      </div>
      <div class="mg-kpis">
        <div><b class="${dropped > 1 ? 'bad' : 'good'}">${Math.round(dropped).toLocaleString()}</b><span>kWh load dropped</span>${cmp}</div>
        <div><b class="${m.unserved_crit_kwh > 0.5 ? 'bad' : 'good'}">${Math.round(m.unserved_crit_kwh)}</b><span>kWh critical lost</span></div>
        <div><b>${m.comfort_violation_k.toFixed(2)}</b><span>K comfort violation<br><i>verified by re-simulation</i></span></div>
        <div><b>${Math.round(m.diesel_litres).toLocaleString()}</b><span>L diesel</span></div>
        <div><b>0</b><span>engine lines changed<br><i>${m.assets} assets, one interface</i></span></div>
      </div>
      <div class="mg-now"><b>${hhmm(k)}</b>
        <span style="color:${MG.pv}">PV ${fmtKW(r.supply.PV[k])}</span>
        <span style="color:${MG.batt}">Battery ${bess > 1 ? '▼' : bess < -1 ? '▲' : ''} ${fmtKW(Math.abs(bess))} · ${r.soc[k].toFixed(0)}%</span>
        <span style="color:${MG.gen}">Genset ${fmtKW(r.supply.Genset[k])}</span>
        <span style="color:${MG.grid}">Grid ${fmtKW(Math.max(0, r.supply.Grid[k]))}</span>
        <span style="color:${MG.flex}">Buildings ${flexNow > 1 ? 'easing ' + fmtKW(flexNow) : flexNow < -1 ? 'repaying ' + fmtKW(-flexNow) : 'at baseline'}</span>
        ${r.ev ? `<span style="color:${MG.ev}">EV ${fmtKW(r.ev[k])}</span>` : ''}
        ${r.unserved[k] > 1 ? `<span style="color:${MG.drop}">Dropped ${fmtKW(r.unserved[k])}</span>` : ''}
      </div>
      ${stackChart(r, k)}
      ${headroomChart(r, k)}
      <div class="mg-key">
        <span><i style="background:${MG.pv}"></i>PV</span><span><i style="background:${MG.batt}"></i>battery</span>
        <span><i style="background:${MG.gen}"></i>genset</span><span><i style="background:${MG.grid}"></i>grid</span>
        <span><i class="dash"></i>baseline demand</span><span><i style="background:${MG.drop}"></i>dropped</span>
        <span><i style="background:${MG.flex}"></i>easing cooling</span><span><i style="background:${MG.repay}"></i>repaying</span>
      </div>`;
  }

  function stackChart(r, k) {
    const d = active.d, { day } = getTime(), W = 300, H = 120;
    const series = [
      ['PV', r.supply.PV.map(v => Math.max(0, v)), MG.pv],
      ['Grid', r.supply.Grid.map(v => Math.max(0, v)), MG.grid],
      ['Genset', r.supply.Genset.map(v => Math.max(0, v)), MG.gen],
      ['BESS', r.supply.BESS.map(v => Math.max(0, v)), MG.batt],
    ];
    const base = d.base[day].load;
    const top = r.supply.PV.map((_, i) => series.reduce((s, x) => s + x[1][i], 0) + r.unserved[i]);
    const ymax = Math.max(...top, ...base) * 1.05;
    const x = i => (i / 95) * W, y = v => H - (v / ymax) * H;
    let acc = new Array(96).fill(0), areas = '';
    for (const [, vals, col] of series) {
      const lo = acc.slice(), hi = acc.map((a2, i) => a2 + vals[i]);
      areas += `<path d="M${hi.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${lo.map((v, i) => `${x(95 - i).toFixed(1)},${y(lo[95 - i]).toFixed(1)}`).join('L')}Z" fill="${col}" fill-opacity=".8"/>`;
      acc = hi;
    }
    const dropHi = acc.map((a2, i) => a2 + r.unserved[i]);
    areas += `<path d="M${dropHi.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${acc.map((v, i) => `${x(95 - i).toFixed(1)},${y(acc[95 - i]).toFixed(1)}`).join('L')}Z" fill="url(#hatch)"/>`;
    const o0 = x(d.outage[0] * 4), o1 = x(d.outage[1] * 4);
    return `<svg class="mg-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="4" height="4" fill="${MG.drop}" fill-opacity=".25"/><line x1="0" y1="0" x2="0" y2="4" stroke="${MG.drop}" stroke-width="2"/></pattern></defs>
      ${opts.grid === 'outage' ? `<rect x="${o0}" y="0" width="${o1 - o0}" height="${H}" fill="#ef4444" fill-opacity=".07"/>` : ''}
      ${areas}
      <path d="M${base.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}" fill="none" stroke="#e3e8ec" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${x(k)}" x2="${x(k)}" y1="0" y2="${H}" stroke="#35d6e0" stroke-width="1.2"/>
    </svg>
    <div class="mg-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24 · peak ${fmtKW(ymax / 1.05)}</span></div>`;
  }

  function headroomChart(r, k) {
    // battery SOC (0-100 %) and the warmest zone's margin to its own comfort limit
    const d = active.d, W = 300, H = 56, x = i => (i / 95) * W;
    const margin = r.soc.map((_, i) => Math.max(...active.members.map(id =>
      r.buildings[id].t[i] - d.envelope[id].comfort_max_c)));
    const yS = v => H - (v / 100) * H, yM = v => H / 2 - (v / 3) * (H / 2);
    return `<div class="mg-sub"><span style="color:${MG.batt}">Battery charge</span><span>Warmest zone vs its comfort limit <b>${margin[k] > 0 ? '+' : ''}${margin[k].toFixed(2)} K</b></span></div>
    <svg class="mg-chart small" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#ef4444" stroke-width="1" stroke-dasharray="4 3"/>
      <path d="M${r.soc.map((v, i) => `${x(i).toFixed(1)},${yS(v).toFixed(1)}`).join('L')}" fill="none" stroke="${MG.batt}" stroke-width="1.5"/>
      <path d="M${margin.map((v, i) => `${x(i).toFixed(1)},${yM(v).toFixed(1)}`).join('L')}" fill="none" stroke="${MG.flex}" stroke-width="1.5"/>
      <line x1="${x(k)}" x2="${x(k)}" y1="0" y2="${H}" stroke="#35d6e0" stroke-width="1.2"/>
    </svg>`;
  }

  // building tooltip extras while a microgrid is active
  function buildingInfo(i) {
    if (!active) return null;
    const b = map.campusBuildings[i];
    if (!active.memberIdx.has(i)) return null;
    const r = run(), { day, step: k } = getTime(), e = active.d.envelope[b.id];
    const p = r.buildings[b.id].p[k], b0 = active.d.base[day].buildings[b.id][k], t = r.buildings[b.id].t[k];
    return { arch: active.d.archetype[b.id], p, base: b0, t, env: e };
  }

  return {
    startPick, cancelPick, pickAt, hoverAt, create, remove, refresh, buildingInfo, load, setOpt,
    run: () => (active ? run() : null), index: index.precincts,
    get mode() { return mode; }, get active() { return active?.d.id ?? null; },
    get data() { return active?.d ?? null; }, opts,
  };
}
