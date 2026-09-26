// Rooftop PV as individual modules. Each PV building gets rows aligned with
// its longest edge, filled from the middle rows out until the building's
// panel count is reached. Each roof glows with the irradiance at its nearest
// weather station, so on a cloudy day the shadows can be seen crossing campus.

import * as THREE from 'three';

const MOD_W = 1.95, MOD_D = 0.95;           // module footprint, m
const PITCH_U = 2.05;                       // along the row
const ROW = 1.05, AISLE = 1.1;              // two-module-deep rows, then an aisle
const MARGIN = 1.2;                         // keep clear of the parapet
const TILT = THREE.MathUtils.degToRad(10);  // low tilt, as in Singapore
const LIFT = 0.7;                           // above the roof plane

export function inside(px, py, poly) {             // even-odd point in polygon (flat array)
  let c = false;
  for (let i = 0, n = poly.length / 2, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function edgeDist(px, py, poly) {
  let d = Infinity;
  for (let i = 0, n = poly.length / 2; i < n; i++) {
    const ax = poly[2 * i], ay = poly[2 * i + 1];
    const bx = poly[(2 * i + 2) % poly.length], by = poly[(2 * i + 3) % poly.length];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
    d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return d;
}
export function longestEdgeAngle(poly) {
  let best = 0, ang = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) {
    const dx = poly[(2 * i + 2) % poly.length] - poly[2 * i];
    const dy = poly[(2 * i + 3) % poly.length] - poly[2 * i + 1];
    const l = dx * dx + dy * dy;
    if (l > best) { best = l; ang = Math.atan2(dy, dx); }
  }
  return ang;
}

// slot centres (map coords) for one roof, in fill order: whole rows, middle rows first.
// (Sorting by distance from the centre instead fills a disc, which no installer does.)
function layoutRoof(b) {
  const a = longestEdgeAngle(b.poly), ca = Math.cos(a), sa = Math.sin(a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < b.poly.length; i += 2) {
    const dx = b.poly[i] - b.cx, dy = b.poly[i + 1] - b.cy;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const slots = [];
  const need = Math.hypot(MOD_W, MOD_D) / 2 + MARGIN;
  for (let v = v0, r = 0; v <= v1; v += ROW + (r % 2 ? AISLE : 0), r++) {
    for (let u = u0; u <= u1; u += PITCH_U) {
      const x = b.cx + u * ca - v * sa, y = b.cy + u * sa + v * ca;
      if (inside(x, y, b.poly) && edgeDist(x, y, b.poly) >= need) slots.push([x, y, Math.abs(v), u]);
    }
  }
  slots.sort((p, q) => p[2] - q[2] || p[3] - q[3]);   // row nearest the middle, then along it
  return { angle: a, slots };
}

export function addPV(map, campus) {
  const roofs = map.campusBuildings.filter(b => b.pv);
  const placed = roofs.map(b => {
    const { angle, slots } = layoutRoof(b);
    return { b, angle, slots: slots.slice(0, b.pv.panels) };
  });
  const n = placed.reduce((s, p) => s + p.slots.length, 0);

  const mat = new THREE.MeshBasicMaterial();              // colour per instance = glow
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(MOD_W, 0.06, MOD_D), mat, n);
  map.scene.add(mesh);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  let lastFlat = -1;
  function place() {
    const flat = map.flat;
    if (Math.abs(flat - lastFlat) < 1e-4) return;
    lastFlat = flat;
    let k = 0;
    for (const { b, angle, slots } of placed) {
      e.set(TILT, angle, 0, 'YXZ');          // yaw to the building grid, then tilt
      q.setFromEuler(e);
      const y = b.h * flat + LIFT;
      for (const [x, yy] of slots) mesh.setMatrixAt(k++, m4.compose(pos.set(x, y, -yy), q, one));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  map.onFrame(place);

  // ghiOf(building) -> W/m² at that roof. A floor keeps arrays visible at night.
  const DARK = new THREE.Color(0x3a2c08), LIT = new THREE.Color(0xffc21a), c = new THREE.Color();
  function setIrradiance(ghiOf) {
    let k = 0, kw = 0;
    for (const { b, slots } of placed) {
      const g = Math.max(0, ghiOf(b) ?? 0);
      c.copy(DARK).lerp(LIT, 0.15 + 0.85 * Math.min(g / 1000, 1));
      for (let i = 0; i < slots.length; i++) mesh.setColorAt(k++, c);
      kw += b.pv.kwp * g / 1000;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return kw;                                // DC-equivalent kW before losses
  }

  return {
    count: n, roofs: placed.length, setIrradiance,
    unplaced: placed.reduce((s, p) => s + p.b.pv.panels - p.slots.length, 0),
  };
}
