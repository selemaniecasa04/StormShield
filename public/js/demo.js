// Demonstration scenarios. Everything produced here is labelled DEMO in the UI and is
// never mixed with live data: while a scenario is active, live sources are not shown.

export const SCENARIOS = {
  thunderstorm: { label: 'Severe thunderstorm with hail', icon: 'storm' },
  flood: { label: 'Flash flooding after heavy rain', icon: 'flood' },
  heat: { label: 'Heatwave', icon: 'heat' },
  wind: { label: 'Windstorm', icon: 'wind' },
  air: { label: 'Smoke and poor air quality', icon: 'air' },
  calm: { label: 'Calm conditions', icon: 'safe' },
};

const P = {
  thunderstorm: { temp: 24, apparent: 26, precip: 18, code: 99, gust: 82, wind: 35, cape: 3200, uv: 3, vis: 3000, prob: 95, aqi: 35, ratio: 2.4, nextCodes: [99, 96, 95, 95, 80, 61] },
  flood: { temp: 19, apparent: 19, precip: 32, code: 65, gust: 45, wind: 22, cape: 600, uv: 1, vis: 2500, prob: 100, aqi: 20, ratio: 6.5, nextCodes: [65, 65, 65, 63, 63, 61], rain6h: [32, 28, 24, 18, 12, 8] },
  heat: { temp: 39, apparent: 44, precip: 0, code: 0, gust: 20, wind: 12, cape: 200, uv: 11, vis: 20000, prob: 0, aqi: 70, ratio: 0.8, nextCodes: [0, 0, 1, 1, 1, 2] },
  wind: { temp: 16, apparent: 10, precip: 1, code: 3, gust: 104, wind: 60, cape: 0, uv: 2, vis: 8000, prob: 30, aqi: 60, ratio: 1.0, nextCodes: [3, 3, 3, 61, 3, 3] },
  air: { temp: 27, apparent: 28, precip: 0, code: 2, gust: 30, wind: 18, cape: 100, uv: 5, vis: 900, prob: 0, aqi: 215, ratio: 0.7, dust: 280, nextCodes: [2, 2, 2, 2, 3, 3] },
  calm: { temp: 22, apparent: 22, precip: 0, code: 1, gust: 14, wind: 8, cape: 50, uv: 5, vis: 24000, prob: 5, aqi: 28, ratio: 0.9, nextCodes: [1, 1, 2, 2, 1, 1] },
};

export function buildDemo(key, centre) {
  const p = P[key]; const now = Date.now();
  const hour = 3600_000; const t0 = Math.floor(now / hour) * hour;
  const hourly = Array.from({ length: 30 }, (_, i) => {
    const decay = Math.max(0, 1 - i / 10);
    return {
      time: t0 + i * hour, temp: p.temp - i * 0.2, apparent: p.apparent - (i > 6 ? (i - 6) * 0.6 : 0),
      precipProb: Math.round(p.prob * decay), precip: p.rain6h ? (p.rain6h[i] ?? 0) : p.precip * decay * (i < 4 ? 1 : 0.3),
      code: p.nextCodes[i] ?? 1, wind: p.wind * (0.6 + 0.4 * decay), gust: p.gust * (0.6 + 0.4 * decay), windDir: 225,
      cape: p.cape * decay, uv: p.uv * decay, visibility: p.vis,
    };
  });
  const weather = {
    provider: 'Demonstration data', kind: 'demo', elevation: 40, demo: true,
    current: { time: now, temp: p.temp, apparent: p.apparent, humidity: 70, isDay: true, precip: p.precip, rain: p.precip, showers: 0, code: p.code, cloud: 80, wind: p.wind, gust: p.gust, windDir: 225, cape: p.cape, uv: p.uv, visibility: p.vis, precipProb: p.prob },
    hourly, daily: [{ time: t0, uvMax: p.uv, tempMax: p.temp + 2, apparentMax: p.apparent + 2, precipSum: p.precip * 3 }], updatedAt: now,
  };
  const air = { provider: 'Demonstration data', demo: true, usAqi: p.aqi, maxNext12h: p.aqi, pm25: p.aqi / 3, pm10: p.aqi / 2, dust: p.dust ?? 10, aod: 0.2, updatedAt: now };
  const river = { provider: 'Demonstration data', demo: true, available: true, median: 40, p95: 120, peak: 40 * p.ratio, ratio: p.ratio, peakTime: now + 30 * hour, now: 40 * Math.min(p.ratio, 1.5), aboveP95: p.ratio > 3, series: [], updatedAt: now };

  const off = (dLat, dLon) => ({ lat: centre.lat + dLat, lon: centre.lon + dLon });
  const reports = [];
  const mk = (id, category, categoryLabel, d, minsAgo, status, text) => reports.push({ id: 'demo-' + id, demo: true, category, categoryLabel, description: text, ...off(...d), observedAt: now - minsAgo * 60_000, submittedAt: now - minsAgo * 60_000, expiresAt: now + 6 * hour, status, confirmations: status === 'under_review' ? 3 : 1, clearances: 0, hasPhoto: false });
  const warnings = [];
  const mw = (event, severity, headline, instruction) => warnings.push({ id: 'demo-w-' + key, demo: true, source: 'demo', sourceName: 'DEMO: example national weather service', event, headline, severity, urgency: 'Immediate', certainty: 'Likely', description: 'This is a demonstration warning. It was not issued by any authority.', instruction, onset: new Date(now - hour).toISOString(), expires: new Date(now + 6 * hour).toISOString(), areaDesc: 'Demonstration area', geoMatched: true, fetchedAt: now });

  if (key === 'thunderstorm') {
    mk(1, 'lightning', 'Lightning strike', [0.02, 0.015], 12, 'submitted', 'Lightning hit a tree near the sports field, branches down.');
    mk(2, 'hail', 'Hail damage', [-0.03, 0.02], 25, 'under_review', 'Marble-sized hail for about 5 minutes, car windscreens cracked.');
    mk(3, 'power_outage', 'Power failure', [0.01, -0.03], 40, 'verified', 'Whole street has no electricity since the storm.');
    mw('Severe Thunderstorm Warning', 'Severe', 'DEMO: Severe thunderstorms with large hail and damaging winds expected', 'Stay indoors and away from windows. Do not shelter under trees.');
  }
  if (key === 'flood') {
    mk(1, 'flooded_road', 'Flooded road', [0.012, 0.008], 15, 'under_review', 'Low-water bridge completely under water, a car is stuck.');
    mk(2, 'flooded_road', 'Flooded road', [-0.02, 0.03], 35, 'submitted', 'Water over the road at the underpass, about knee deep.');
    mk(3, 'water_outage', 'Water outage', [0.03, -0.01], 120, 'submitted', 'No running water in the area since this morning.');
    mw('Flood Warning', 'Extreme', 'DEMO: Disruptive rain leading to flash flooding of low-lying roads and settlements', 'Move to higher ground. Do not cross flooded roads or low-water bridges.');
  }
  if (key === 'heat') mw('Heatwave', 'Moderate', 'DEMO: Heatwave conditions expected to persist for three days', 'Drink plenty of water and avoid strenuous activity during the day.');
  if (key === 'wind') {
    mk(1, 'fallen_tree', 'Fallen tree', [0.01, 0.02], 20, 'verified', 'Large tree blocking both lanes.');
    mk(2, 'strong_wind', 'Strong wind', [-0.015, -0.01], 8, 'submitted', 'Roof sheeting lifting on houses along the main road.');
    mw('Damaging Winds', 'Severe', 'DEMO: Damaging winds with gusts above 100 km/h', 'Secure loose objects and stay indoors where possible.');
  }
  if (key === 'air') mk(1, 'other', 'Other weather hazard', [0.02, 0.01], 30, 'submitted', 'Thick smoke from veld fire, visibility very low on the highway.');

  const grid = [];
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    const d = Math.hypot(x, y); const f = Math.max(0.15, 1 - d / 3.2);
    grid.push({ lat: centre.lat + y * 0.12, lon: centre.lon + x * 0.14, elevation: 40 + d * 20, temp: p.temp - d, apparent: p.apparent - d * 1.2,
      precip: p.precip * f, code: f > 0.5 ? p.code : 3, wind: p.wind * f, gust: p.gust * f, windDir: 225,
      precip6h: (p.rain6h ? 120 : p.precip * 3) * f, gust6h: p.gust * f, thunder6h: key === 'thunderstorm' && f > 0.4, hail6h: key === 'thunderstorm' && f > 0.6, time: now,
      usAqi: Math.round(p.aqi * f + 20), dust: (p.dust ?? 10) * f });
  }
  return { weather, air, river, reports, warnings, grid, terrain: { nearestWaterwayM: key === 'flood' ? 150 : 900, nearestWaterwayName: key === 'flood' ? 'DEMO river' : null, fords: [], demo: true } };
}
