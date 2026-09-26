// EV charging sites. Two kinds, labelled differently:
//   fleet   the managed fleet the dispatcher schedules (synthetic, at an OSM car park)
//   public  chargers NUS already has, from public listings (documented, not dispatched)
// Each surface site is a green pad with charger posts (DC fast chargers taller);
// every site has a floating marker and an HTML label so it reads from the overview.

import * as THREE from 'three';
import { inside, edgeDist, longestEdgeAngle } from './pv.js';

export const EV_GREEN = 0x22c55e;
const BAY_W = 3.0, ROW_GAP = 7.0, MARGIN = 2.5;
const REF_DIST = 2600;
const MARK_R = { fleet: 16, public: 11 };
const UNKNOWN_POINTS = 2;              // drawn where a site's charger count is not published

function shape(flat) {
  const s = new THREE.Shape();
  s.moveTo(flat[0], flat[1]);
  for (let i = 2; i < flat.length; i += 2) s.lineTo(flat[i], flat[i + 1]);
  return s;
}

// charger spots: rows along the lot's long axis, filled from the middle row out
function bays(site, count) {
  const poly = site.poly;
  const a = longestEdgeAngle(poly), ca = Math.cos(a), sa = Math.sin(a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const dx = poly[i] - site.cx, dy = poly[i + 1] - site.cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const out = [];
  for (let v = v0 + MARGIN; v <= v1 - MARGIN; v += ROW_GAP)
    for (let u = u0 + MARGIN; u <= u1 - MARGIN; u += BAY_W) {
      const x = site.cx + u * ca - v * sa, y = site.cy + u * sa + v * ca;
      if (inside(x, y, poly) && edgeDist(x, y, poly) >= MARGIN * 0.8) out.push([x, y, Math.abs(v), Math.abs(u)]);
    }
  out.sort((p, q) => p[2] - q[2] || p[3] - q[3]);
  return { angle: a, spots: out.slice(0, count) };
}

export function labelText(s) {
  return s.kind === 'fleet' ? `EV fleet · ${s.vehicles}` : `EV · ${s.points ?? '?'}`;
}

export function addEV(map, campus, container) {
  const sites = campus.ev || [];
  const group = new THREE.Group();
  map.scene.add(group);

  // ---- pads and outlines (surface sites only) ----
  const pickables = [];
  sites.forEach(site => {
    if (!site.poly) return;
    const pad = new THREE.Mesh(new THREE.ShapeGeometry(shape(site.poly)).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: EV_GREEN, transparent: true,
        opacity: site.kind === 'fleet' ? 0.45 : 0.35, depthWrite: false }));
    pad.position.y = 0.4;
    pad.userData.site = site;
    group.add(pad);
    pickables.push(pad);

    const ring = [];
    for (let i = 0; i < site.poly.length; i += 2) ring.push(site.poly[i], 0.5, -site.poly[i + 1]);
    ring.push(site.poly[0], 0.5, -site.poly[1]);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: EV_GREEN })));
  });

  // ---- charger posts: one instance per charge point; DC fast chargers are taller ----
  const posts = [];                         // [x, y, angle, isDC]
  sites.forEach(site => {
    if (!site.poly) return;
    const types = site.chargers
      ? site.chargers.flatMap(c => Array(c.n).fill(c.type))
      : Array(UNKNOWN_POINTS).fill('AC');
    const { angle, spots } = bays(site, types.length);
    spots.forEach(([x, y], i) => posts.push([x, y, angle, types[i] === 'DC']));
  });
  const bodyGeo = new THREE.BoxGeometry(0.9, 1, 0.6).translate(0, 0.5, 0);
  const body = new THREE.InstancedMesh(bodyGeo,
    new THREE.MeshLambertMaterial({ color: 0x1b5e36, emissive: EV_GREEN, emissiveIntensity: 0.55 }), posts.length);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.35, 0.8),
    new THREE.MeshBasicMaterial({ color: 0x86efac }), posts.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let lastFlat = -1;
  function placePosts(flat) {
    posts.forEach(([x, y, angle, dc], i) => {
      const h = (dc ? 3.2 : 2.2) * Math.max(flat, 0.05);
      q.setFromAxisAngle(up, angle);
      body.setMatrixAt(i, m4.compose(p.set(x, 0.4, -y), q, sc.set(dc ? 1.4 : 1, h, dc ? 1.3 : 1)));
      head.setMatrixAt(i, m4.compose(p.set(x, 0.4 + h + 0.17, -y), q, sc.set(dc ? 1.4 : 1, 1, dc ? 1.3 : 1)));
    });
    body.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = true;
  }
  group.add(body, head);

  // ---- floating markers, stems and HTML labels ----
  const markers = sites.map(site => {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({ color: EV_GREEN }));
    m.userData.site = site;
    group.add(m);
    pickables.push(m);
    return m;
  });
  const stemPos = new Float32Array(sites.length * 6);
  const stemGeo = new THREE.BufferGeometry();
  stemGeo.setAttribute('position', new THREE.BufferAttribute(stemPos, 3));
  group.add(new THREE.LineSegments(stemGeo, new THREE.LineBasicMaterial({
    color: EV_GREEN, transparent: true, opacity: 0.6 })));

  const labels = sites.map(s => {
    const el = document.createElement('div');
    el.className = `ev-label ${s.kind}`;
    el.innerHTML = `<svg viewBox="0 0 12 16"><path d="M7 0L1 9h4l-1 7 6-9H6z"/></svg>${labelText(s)}`;
    container.appendChild(el);
    return el;
  });
  const proj = new THREE.Vector3();
  // underground sites sit under a building: start their stem at its roof
  const base = sites.map(s => (s.underground ? map.roofHeightAt(s.cx, s.cy) : 0) + 0.5);

  let hovered = -1;
  map.onFrame(now => {
    const d = map.camera.position.distanceTo(map.controls.target) / REF_DIST;
    const flat = map.flat;
    if (Math.abs(flat - lastFlat) > 1e-4) { placePosts(flat); lastFlat = flat; }
    markers.forEach((m, i) => {
      const s = sites[i];
      const y0 = base[i] * flat;
      const top = y0 + (s.kind === 'fleet' ? 18 : 12) + (s.kind === 'fleet' ? 30 : 22) * flat;
      const r = MARK_R[s.kind] * d * (i === hovered ? 1.5 : 1);
      m.position.set(s.cx, top + r, -s.cy);
      m.scale.set(r * 0.8, r, r * 0.8);
      m.rotation.y = now * 0.0008;
      stemPos.set([s.cx, y0 + 0.5, -s.cy, s.cx, top, -s.cy], i * 6);
      proj.set(s.cx, top + 2.4 * r, -s.cy).project(map.camera);
      const el = labels[i];
      el.style.display = proj.z > 1 ? 'none' : '';
      el.style.left = ((proj.x + 1) / 2 * container.clientWidth) + 'px';
      el.style.top = ((1 - proj.y) / 2 * container.clientHeight) + 'px';
    });
    stemGeo.attributes.position.needsUpdate = true;
  });

  function pick(clientX, clientY) {
    const hit = map.rayAt(clientX, clientY).intersectObjects(pickables, false)[0];
    return hit ? sites.indexOf(hit.object.userData.site) : -1;
  }

  const fleet = sites.filter(s => s.kind === 'fleet');
  const pub = sites.filter(s => s.kind === 'public');
  return {
    sites, pick, setHover: i => { hovered = i; },
    fleet: { sites: fleet, points: fleet.reduce((a, s) => a + s.points, 0), kw: fleet.reduce((a, s) => a + s.kw, 0) },
    public: { sites: pub, points: pub.reduce((a, s) => a + (s.points || 0), 0),
              unknown: pub.filter(s => s.points == null).length },
  };
}
