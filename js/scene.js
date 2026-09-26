// Dark 3D base map: ground, land use, roads, and extruded buildings.
//
// Frame: campus.json is metres east (x) / north (y). three.js is y-up, so
// map (x, y) -> world (x, 0, -y) and height goes up world y.
//
// Campus buildings are ONE merged mesh with per-vertex colour. `ranges`
// records which vertices belong to which building, so picking (faceIndex ->
// building) and recolouring per timestep stay cheap for hundreds of buildings.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

const C = {
  bg:      0x0c0f13,
  ground:  0x11151a,
  green:   0x132019,
  water:   0x0d1a27,
  context: 0x2a3038,
  outline: 0x35d6e0,
  hover:   0x35d6e0,
  roads: { major: 0x4a5561, minor: 0x353e48, service: 0x262d35, path: 0x1f252c },
};

// plum -> magenta -> coral -> cream (the reference's height ramp); matches --r0..--r4
const RAMP = ['#4a1650', '#9c2477', '#e0508f', '#f59a8c', '#fde3c8'].map(c => new THREE.Color(c));
export const RAMP_MAX_M = 80;
// square-root scale: most campus blocks are 12-24 m, a linear scale paints them all one colour
export const heightT = h => Math.sqrt(Math.min(h, RAMP_MAX_M) / RAMP_MAX_M);

export function rampColor(t, out = new THREE.Color()) {
  t = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(t), RAMP.length - 2);
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], t - i);
}

function shapeFrom(flat) {
  const s = new THREE.Shape();
  s.moveTo(flat[0], flat[1]);
  for (let i = 2; i < flat.length; i += 2) s.lineTo(flat[i], flat[i + 1]);
  s.closePath();
  return s;
}

// Extrude along +z in map coords, then rotate so +z becomes world up.
function extrude(flat, h) {
  const g = new THREE.ExtrudeGeometry(shapeFrom(flat), { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute('uv');
  return g;
}

function flatArea(polys, color, y) {
  if (!polys.length) return null;
  const geos = polys.map(p => {
    const g = new THREE.ShapeGeometry(shapeFrom(p));
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    return g;
  });
  const m = new THREE.Mesh(mergeGeometries(geos),
    new THREE.MeshBasicMaterial({ color, depthWrite: false }));
  m.position.y = y;
  m.renderOrder = -1;
  return m;
}

function lines(polylines, color, y, opacity = 1, closed = false) {
  const pos = [];
  for (const l of polylines) {
    const n = l.length / 2;
    for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
      const a = i, b = (i + 1) % n;
      pos.push(l[2 * a], y, -l[2 * a + 1], l[2 * b], y, -l[2 * b + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
}

export function createScene(container, campus) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(C.bg);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.bg, 2600, 6500);

  const camera = new THREE.PerspectiveCamera(38, 1, 5, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;             // pan across the ground, like a map
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.minDistance = 150;
  controls.maxDistance = 5200;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(78);

  // ---- lighting: cool sky, warm low sun from the north-west ----------------
  scene.add(new THREE.HemisphereLight(0xc9d6ff, 0x0b0d10, 1.35));
  const sun = new THREE.DirectionalLight(0xfff1e0, 1.6);
  sun.position.set(-900, 1400, -500);
  scene.add(sun);

  // ---- ground, land use, roads ------------------------------------------------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000),
    new THREE.MeshBasicMaterial({ color: C.ground }));
  ground.rotation.x = -Math.PI / 2;
  ground.renderOrder = -2;
  scene.add(ground);

  const base = new THREE.Group();
  [flatArea(campus.green, C.green, 0.05), flatArea(campus.water, C.water, 0.08)]
    .forEach(m => m && base.add(m));
  for (const [cls, color] of Object.entries(C.roads)) {
    const ls = campus.roads.filter(r => r.c === cls).map(r => r.line);
    if (ls.length) base.add(lines(ls, color, 0.15 + (cls === 'major' ? 0.05 : 0)));
  }
  base.add(lines(campus.campus_outline, C.outline, 0.3, 0.45, true));
  scene.add(base);

  // ---- buildings ----------------------------------------------------------------
  const buildings = new THREE.Group();
  scene.add(buildings);

  const ctxGeos = campus.buildings.filter(b => !b.campus).map(b => extrude(b.poly, b.h));
  const ctxMesh = new THREE.Mesh(mergeGeometries(ctxGeos), new THREE.MeshLambertMaterial({
    color: C.context, transparent: true, opacity: 0.55 }));
  buildings.add(ctxMesh);

  const campusB = campus.buildings.filter(b => b.campus);
  const ranges = [];                       // [{ b, start, count }] in vertex units
  let cursor = 0;
  const geos = campusB.map(b => {
    const g = extrude(b.poly, b.h);
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    ranges.push({ b, start: cursor, count: n });
    cursor += n;
    return g;
  });
  const geo = mergeGeometries(geos);
  const colorAttr = geo.attributes.color;
  const campusMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  buildings.add(campusMesh);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
  buildings.add(edges);

  const baseColor = ranges.map(r => rampColor(heightT(r.b.h)));
  const current = baseColor.map(c => c.clone());   // what each building shows now
  const tmp = new THREE.Color();
  function paint(i, color) {
    const { start, count } = ranges[i];
    for (let v = start; v < start + count; v++) colorAttr.setXYZ(v, color.r, color.g, color.b);
  }
  function paintAll() {
    ranges.forEach((_, i) => paint(i, i === hovered ? tmp.set(C.hover) : current[i]));
    colorAttr.needsUpdate = true;
  }
  // overlays recolour buildings: colorOf(i) -> THREE.Color, or null for the
  // height ramp (dimmed when `dim` is set). Pass null to restore everything.
  function setColors(colorOf, dim = 0) {
    ranges.forEach((_, i) => {
      const c = colorOf && colorOf(i);
      current[i].copy(c || baseColor[i]);
      if (!c && dim) current[i].multiplyScalar(1 - dim);
    });
    paintAll();
  }
  let hovered = -1;
  paintAll();

  // ---- picking ----------------------------------------------------------------
  const starts = Int32Array.from(ranges, r => r.start);
  function rangeOfVertex(v) {                // binary search: last start <= v
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rayAt(clientX, clientY) {         // shared by every pickable layer
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray;
  }
  function pick(clientX, clientY) {
    const hit = rayAt(clientX, clientY).intersectObject(campusMesh, false)[0];
    return hit ? rangeOfVertex(hit.face.a) : -1;
  }

  // roof height under a map point (0 on open ground); used to seat roof stations
  const down = new THREE.Raycaster();
  function roofHeightAt(x, y) {
    buildings.updateMatrixWorld();           // may run before the first render
    down.set(new THREE.Vector3(x, 1000, -y), new THREE.Vector3(0, -1, 0));
    const hit = down.intersectObjects([campusMesh, ctxMesh], false)[0];
    return hit ? hit.point.y / buildings.scale.y : 0;
  }

  function setHover(i) {
    if (i === hovered) return;
    if (hovered >= 0) paint(hovered, current[hovered]);
    hovered = i;
    if (i >= 0) paint(i, tmp.set(C.hover));
    colorAttr.needsUpdate = true;
  }

  // ---- camera views + 2D/3D -----------------------------------------------------
  // centre on the campus bounding box: the mean leans south, where buildings are dense
  const cxs = campusB.map(b => b.cx), cys = campusB.map(b => b.cy);
  const campusCentre = new THREE.Vector3(
    (Math.min(...cxs) + Math.max(...cxs)) / 2, 0,
    -(Math.min(...cys) + Math.max(...cys)) / 2);
  const VIEWS = {
    '3d': { offset: new THREE.Vector3(1050, 1500, 1750), flat: 1 },
    '2d': { offset: new THREE.Vector3(0, 3900, 1),     flat: 0.004 },
  };
  let mode = '3d';
  let anim = null;

  function flyTo(target, offset, flat, ms = 900) {
    const from = { pos: camera.position.clone(), tgt: controls.target.clone(), flat: buildings.scale.y };
    const to = { pos: target.clone().add(offset), tgt: target.clone(), flat };
    const t0 = performance.now();
    anim = now => {
      let k = Math.min((now - t0) / ms, 1);
      k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;    // ease in-out cubic
      camera.position.lerpVectors(from.pos, to.pos, k);
      controls.target.lerpVectors(from.tgt, to.tgt, k);
      buildings.scale.y = from.flat + (to.flat - from.flat) * k;
      if (k >= 1) anim = null;
    };
  }

  function setView(m, ms) {
    mode = m;
    const v = VIEWS[m];
    controls.enableRotate = m === '3d';
    controls.maxPolarAngle = m === '3d' ? THREE.MathUtils.degToRad(78) : 0.001;
    flyTo(controls.target.clone().setY(0), v.offset, v.flat, ms);
  }
  function resetView() { flyTo(campusCentre, VIEWS[mode].offset, VIEWS[mode].flat); }
  function focusOn(x, y, dist = 420) {       // fly to a map point, keeping the view mode
    const off = VIEWS[mode].offset.clone().setLength(dist);
    flyTo(new THREE.Vector3(x, 0, -y), off, VIEWS[mode].flat, 1100);
  }
  function zoom(f) {
    const dir = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(dir.length() * f, controls.minDistance, controls.maxDistance);
    flyTo(controls.target.clone(), dir.setLength(len), buildings.scale.y, 350);
  }

  camera.position.copy(campusCentre).add(VIEWS['3d'].offset);
  controls.target.copy(campusCentre);

  // ---- loop ---------------------------------------------------------------------
  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const hooks = [];                          // other layers' per-frame updates
  renderer.setAnimationLoop(now => {
    if (anim) anim(now);
    controls.update();
    hooks.forEach(f => f(now));
    renderer.render(scene, camera);
  });

  return {
    campusBuildings: campusB,
    pick, setHover, setView, resetView, zoom, focusOn, rayAt, roofHeightAt, setColors,
    onFrame: f => hooks.push(f),
    get flat() { return buildings.scale.y; },      // 1 in 3D, ~0 in 2D
    get mode() { return mode; },
    scene, camera, controls,
    canvas: renderer.domElement,
  };
}
