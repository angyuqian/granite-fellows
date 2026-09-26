// The 40-station weather network as pins: a stem from the mount point to a
// head coloured by the selected weather layer (metrics.js) at the current step.
// Roof stations stand on the roof they are mounted on. Optional wind arrows
// point downwind at each head, length by speed. Heads keep a near-constant
// screen size.

import * as THREE from 'three';
import { METRICS, heatIndex } from './metrics.js';

const STEM = 28;                  // m above the mount point
const HEAD_R = 7;                 // m at the reference distance
const REF_DIST = 2600;
const NO_DATA = new THREE.Color(0x56616c);

function rampFn(stops) {
  const R = stops.map(c => new THREE.Color(c));
  return (t, out = new THREE.Color()) => {
    t = Math.min(Math.max(t, 0), 1) * (R.length - 1);
    const i = Math.min(Math.floor(t), R.length - 2);
    return out.copy(R[i]).lerp(R[i + 1], t - i);
  };
}
const RAMPS = Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, rampFn(m.stops)]));

// flat arrow along +x, unit length, lying in the ground plane
function arrowGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.07); s.lineTo(0.62, -0.07); s.lineTo(0.62, -0.2);
  s.lineTo(1, 0); s.lineTo(0.62, 0.2); s.lineTo(0.62, 0.07); s.lineTo(0, 0.07);
  s.closePath();
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);   // shape y -> world -z (map north)
}

export function addStations(map, weather) {
  const S = weather.stations;
  const n = S.length;
  const base = S.map(s => (s.mount.startsWith('Roof') ? map.roofHeightAt(s.x_m, s.y_m) : 0) + 0.5);

  // derived series (feels-like) computed once per day and station
  for (const d of Object.values(weather.days))
    for (const st of [d.campus, ...Object.values(d.stations)])
      st.feels = st.t_air.map((t, i) => heatIndex(t, st.rh[i]));

  const group = new THREE.Group();
  map.scene.add(group);

  // stems: one LineSegments, y rewritten when the map flattens to 2D
  const stemPos = new Float32Array(n * 6);
  const stemGeo = new THREE.BufferGeometry();
  stemGeo.setAttribute('position', new THREE.BufferAttribute(stemPos, 3));
  group.add(new THREE.LineSegments(stemGeo, new THREE.LineBasicMaterial({
    color: 0xa3b0ba, transparent: true, opacity: 0.55 })));

  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial(), n);
  heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(heads);

  // a faint ring on the ground under each station, so they read in 2D too
  const rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.75, 1, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6fb3ff, transparent: true, opacity: 0.55, depthWrite: false }), n);
  group.add(rings);

  const arrows = new THREE.InstancedMesh(arrowGeometry(), new THREE.MeshBasicMaterial({
    color: 0xe3e8ec, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }), n);
  arrows.visible = false;
  group.add(arrows);

  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let hovered = -1, selected = -1;
  const tops = new Float32Array(n);             // head height, for anchoring pop-ups
  let day = null, step = 0, metric = 'temp', lo = 0, hi = 1;

  function layout() {
    const flat = map.flat;
    const k = map.camera.position.distanceTo(map.controls.target) / REF_DIST;
    S.forEach((s, i) => {
      const y0 = base[i] * flat + 0.3;
      const y1 = y0 + STEM * (0.25 + 0.75 * flat);
      tops[i] = y1;
      stemPos.set([s.x_m, y0, -s.y_m, s.x_m, y1, -s.y_m], i * 6);
      const r = HEAD_R * k * (i === hovered || i === selected ? 1.6 : 1);
      heads.setMatrixAt(i, m4.compose(v.set(s.x_m, y1, -s.y_m), q.identity(), sc.set(r, r, r)));
      const rr = r * 1.4;
      rings.setMatrixAt(i, m4.compose(v.set(s.x_m, y0, -s.y_m), q, sc.set(rr, 1, rr)));

      if (arrows.visible && day) {
        const d = weather.days[day].stations[s.id];
        const spd = d.wind[step], dir = d.wind_dir[step];
        if (spd == null || dir == null) {
          arrows.setMatrixAt(i, m4.makeScale(0, 0, 0));
        } else {
          // dir is where the wind comes FROM (clockwise from north); point downwind
          const to = THREE.MathUtils.degToRad(dir + 180);
          const yaw = Math.atan2(Math.cos(to), Math.sin(to));      // map angle from east, CCW
          const len = k * (45 + 50 * Math.min(spd, 4));     // m, readable at overview zoom
          q.setFromAxisAngle(up, yaw);
          arrows.setMatrixAt(i, m4.compose(v.set(s.x_m - Math.cos(yaw) * len / 2, y1 + 0.5,
            -(s.y_m - Math.sin(yaw) * len / 2)), q, sc.set(len, 1, k * 34)));
          q.identity();
        }
      }
    });
    stemGeo.attributes.position.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = rings.instanceMatrix.needsUpdate = true;
    if (arrows.visible) arrows.instanceMatrix.needsUpdate = true;
  }
  map.onFrame(layout);

  function rescale() {
    const M = METRICS[metric];
    if (Array.isArray(M.range)) [lo, hi] = M.range;
    else {
      const all = Object.values(weather.days[day].stations)
        .flatMap(st => M.series(st)).filter(x => x != null);
      lo = Math.min(...all); hi = Math.max(...all);
    }
  }
  const col = new THREE.Color();
  function recolor() {
    const M = METRICS[metric], ramp = RAMPS[metric];
    S.forEach((s, i) => {
      const x = M.series(weather.days[day].stations[s.id])[step];
      heads.setColorAt(i, x == null ? NO_DATA : ramp((x - lo) / (hi - lo), col));
    });
    heads.instanceColor.needsUpdate = true;
  }
  function setTime(dayKey, k) {
    const changed = dayKey !== day;
    day = dayKey; step = k;
    if (changed) rescale();
    recolor();
  }
  function setMetric(m) {
    metric = m;
    if (day) { rescale(); recolor(); }        // before the first setTime, just remember it
  }

  function pick(clientX, clientY) {
    const hit = map.rayAt(clientX, clientY).intersectObject(heads, false)[0];
    return hit ? hit.instanceId : -1;
  }
  function reading(i) {
    const s = S[i], d = weather.days[day].stations[s.id];
    return { station: s, t_air: d.t_air[step], rh: d.rh[step], ghi: d.ghi[step], wind: d.wind[step],
             wind_dir: d.wind_dir[step], feels: d.feels[step] };
  }
  // the nearest station with a reading of `key` at this step (for local PV glow)
  const byDistance = new Map();
  function nearestValue(x, y, key) {
    const tag = `${x},${y}`;
    if (!byDistance.has(tag))
      byDistance.set(tag, S.map((s, i) => [Math.hypot(s.x_m - x, s.y_m - y), i])
        .sort((a, b) => a[0] - b[0]).map(p => p[1]));
    for (const i of byDistance.get(tag)) {
      const v = weather.days[day].stations[S[i].id][key][step];
      if (v != null) return v;
    }
    return weather.days[day].campus[key][step];
  }

  return {
    setTime, setMetric, pick, reading, nearestValue,
    setHover: i => { hovered = i; }, setSelected: i => { selected = i; },
    setWind: on => { arrows.visible = on; },
    headPosition: (i, out = new THREE.Vector3()) => out.set(S[i].x_m, tops[i], -S[i].y_m),
    series: i => weather.days[day].stations[S[i].id],
    stations: S,
    get day() { return day; }, get metric() { return metric; }, get range() { return [lo, hi]; },
  };
}
