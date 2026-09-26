// Weather layers the station pins can show, one at a time. Each has its own
// single-purpose colour scale, chosen to stay clear of the other map layers
// (magenta buildings, gold PV, green EV).

// NOAA heat index (Rothfusz regression, simple formula below 80 °F), in °C.
export function heatIndex(tC, rh) {
  if (tC == null || rh == null) return null;
  const T = tC * 9 / 5 + 32, R = rh;
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
      - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
      + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    if (R < 13 && T >= 80 && T <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (R > 85 && T >= 80 && T <= 87) hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return (hi - 32) * 5 / 9;
}

// series(d) -> per-step values for one station's (or the campus's) day record
export const METRICS = {
  temp: {
    label: 'Air temperature', unit: '°C', d: 1,
    stops: ['#1e3a8a', '#2f6fd6', '#6fb3ff', '#e3f1ff'],        // cool -> hot, darker -> brighter
    series: d => d.t_air,
    range: 'day',                                               // scaled to the day's spread
  },
  sun: {
    label: 'Sunlight', unit: 'W/m²', d: 0,
    stops: ['#232733', '#6b5a2a', '#e8b93a', '#fff4cf'],        // dark -> sunlit
    series: d => d.ghi,
    range: [0, 1000],                                           // fixed, so the days compare
  },
  feels: {
    label: 'Feels like', unit: '°C', d: 1,
    stops: ['#2dd4bf', '#facc15', '#fb923c', '#ef4444'],        // heat-stress semantics
    series: d => d.t_air.map((t, i) => heatIndex(t, d.rh[i])),
    range: [26, 46],                                            // NOAA caution 27 °C, danger 41 °C
  },
};

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = deg => deg == null ? '' : COMPASS[Math.round(deg / 45) % 8];
