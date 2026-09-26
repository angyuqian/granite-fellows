// Click-to-open weather card for one station, pinned above its pin and
// following it as the camera moves. Each chart plots the station against the
// campus median, so local microclimate (a roof in full sun, a shaded
// walkway) stands out.

import * as THREE from 'three';
import { compass } from './metrics.js';

const VARS = [
  { k: 't_air', label: 'Air temperature', unit: '°C', d: 1, color: '#e06a58' },
  { k: 'feels', label: 'Feels like',      unit: '°C', d: 1, color: '#fb923c' },
  { k: 'rh',    label: 'Humidity',        unit: '%',  d: 0, color: '#3987e5' },
  { k: 'ghi',   label: 'Sunlight',        unit: 'W/m²', d: 0, color: '#c98500', zero: true },
  { k: 'wind',  label: 'Wind',            unit: 'm/s', d: 1, color: '#35d6e0', zero: true },
];
const W = 260, H = 38;

function path(arr, x, y) {                 // gaps stay gaps: a null starts a new segment
  let d = '', pen = false;
  arr.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function createStationPopup(map, stations, weather, getTime, container) {
  const el = document.createElement('div');
  el.className = 'popup';
  el.hidden = true;
  container.appendChild(el);
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('click', e => { if (e.target.closest('.popup-close')) close(); });

  let idx = -1;
  const v = new THREE.Vector3();

  function render() {
    if (idx < 0) return;
    const { day, step } = getTime();
    const s = stations.stations[idx];
    const st = weather.days[day].stations[s.id];
    const campus = weather.days[day].campus;
    const x = i => (i / 95) * W;
    const n = st.t_air.filter(t => t != null).length;

    const charts = VARS.map(V => {
      const a = st[V.k], c = campus[V.k];
      const all = [...a, ...c].filter(t => t != null);
      let lo = V.zero ? 0 : Math.min(...all), hi = Math.max(...all);
      if (hi - lo < 1e-6) hi = lo + 1;
      const pad = (hi - lo) * 0.08;
      if (!V.zero) lo -= pad;
      hi += pad;
      const y = t => H - ((t - lo) / (hi - lo)) * H;
      const now = a[step], ref = c[step];
      const delta = now != null && ref != null ? now - ref : null;
      const dtxt = delta == null ? '' :
        `<span class="delta ${Math.abs(delta) < 10 ** -V.d / 2 ? '' : delta > 0 ? 'up' : 'down'}">` +
        `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(V.d)} vs campus</span>`;
      return `<div class="pc">
        <div class="pc-head"><span>${V.label}${V.k === 'wind' && st.wind_dir[step] != null
            ? ` <span class="dir">from ${compass(st.wind_dir[step])}</span>` : ''}</span>
          <span><b>${now == null ? '—' : now.toFixed(V.d)}</b> ${V.unit} ${dtxt}</span></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <path d="${path(c, x, y)}" fill="none" stroke="#6e7c87" stroke-width="1" stroke-dasharray="3 3"/>
          <path d="${path(a, x, y)}" fill="none" stroke="${V.color}" stroke-width="1.6"/>
          <line x1="${x(step)}" x2="${x(step)}" y1="0" y2="${H}" stroke="#35d6e0" stroke-width="1"/>
        </svg></div>`;
    }).join('');

    el.innerHTML = `
      <div class="popup-head">
        <div><b>${s.id}</b> · ${s.name}<div class="popup-sub">${s.mount} · ${n}/96 readings on ${weather.days[day].date}</div></div>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      ${charts}
      <div class="popup-key"><span><i></i>this station</span><span><i class="dash"></i>campus median</span></div>`;
  }

  function open(i) {
    idx = i;
    stations.setSelected(i);
    render();
    el.hidden = false;
    position();
  }
  function close() {
    idx = -1;
    stations.setSelected(-1);
    el.hidden = true;
  }

  function position() {
    if (idx < 0) return;
    stations.headPosition(idx, v).project(map.camera);
    const w = container.clientWidth, h = container.clientHeight;
    if (v.z > 1) { el.style.visibility = 'hidden'; return; }     // behind the camera
    el.style.visibility = '';
    const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h;
    const pw = el.offsetWidth, ph = el.offsetHeight;
    const left = Math.min(Math.max(px - pw / 2, 8), w - pw - 8);
    let top = py - ph - 18;
    el.classList.toggle('below', top < 8);
    if (top < 8) top = py + 18;
    el.style.left = left + 'px';
    el.style.top = Math.min(top, h - ph - 8) + 'px';
    el.style.setProperty('--tip-x', `${Math.min(Math.max(px - left, 14), pw - 14)}px`);
  }
  map.onFrame(position);

  return { open, close, update: render, get index() { return idx; } };
}
