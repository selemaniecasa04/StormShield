// Journey safety: samples forecast conditions along each candidate route at the time
// you would reach each point, then adds fords, community reports and official warnings.
import { routes as fetchRoutes, server } from './providers/external.js';
import { fordsAlongRoute } from './providers/osm.js';
import { fetchJson, haversineM, distToPolylineM, isThunder, isHail, WMO } from './util.js';
import { RISK_CONFIG } from './risk.js';

const T = RISK_CONFIG.thresholds;
const step = (v, table, below = false) => { let s = 0; if (v == null) return 0; for (const [t, sev] of table) if (below ? v <= t : v >= t) s = sev; return s; };

export const RATINGS = [
  { max: 0.3, rating: 'LOW RISK', css: 'safe' },
  { max: 0.55, rating: 'MODERATE RISK', css: 'watch' },
  { max: 0.8, rating: 'HIGH RISK', css: 'warning' },
  { max: Infinity, rating: 'DANGEROUS', css: 'emergency' },
];
const rate = (s) => RATINGS.find((r) => s < r.max);

function samplePoints(route, depart) {
  const c = route.coords; const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + haversineM(c[i - 1], c[i]));
  const total = cum[cum.length - 1] || 1;
  const n = Math.min(10, Math.max(3, Math.ceil(total / 15000) + 1));
  const out = [];
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    let i = cum.findIndex((d) => d >= target); if (i < 0) i = c.length - 1;
    out.push({ lat: c[i].lat, lon: c[i].lon, frac: target / total, eta: depart + route.duration * 1000 * (target / total) });
  }
  return out;
}

async function weatherAt(points) {
  const r4 = (n) => Math.round(n * 1e3) / 1e3;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${points.map((p) => r4(p.lat)).join(',')}&longitude=${points.map((p) => r4(p.lon)).join(',')}&hourly=precipitation,weather_code,wind_gusts_10m,visibility,apparent_temperature&forecast_days=2&timeformat=unixtime&wind_speed_unit=kmh`;
  const j = await fetchJson(url, { ttl: 10 * 60_000, provider: 'Open-Meteo route forecast', timeout: 20000 });
  const arr = Array.isArray(j) ? j : [j];
  return arr.map((d, i) => {
    const h = d.hourly; const eta = points[i].eta;
    let idx = h.time.findIndex((t) => t * 1000 > eta) - 1; if (idx < 0) idx = 0;
    return { precip: h.precipitation[idx], code: h.weather_code[idx], gust: h.wind_gusts_10m[idx], visibility: h.visibility?.[idx], apparent: h.apparent_temperature[idx], time: h.time[idx] * 1000 };
  });
}

function demoWeatherAt(points, grid) {
  return points.map((p) => {
    let best = grid[0], bd = Infinity;
    for (const g of grid) { const d = haversineM(p, g); if (d < bd) { bd = d; best = g; } }
    const far = bd > 40000;
    return far ? { precip: 0, code: 1, gust: 15, visibility: 20000, apparent: 22, time: p.eta } : { precip: best.precip, code: best.code, gust: best.gust, visibility: best.precip > 15 ? 2000 : 15000, apparent: best.apparent, time: p.eta };
  });
}

function scoreSample(w) {
  const out = [];
  const add = (label, s, detail) => { if (s > 0.01) out.push({ label, severity: s, detail }); };
  add('Thunderstorms', isThunder(w.code) ? (isHail(w.code) ? 0.7 : 0.55) : 0, WMO[w.code]);
  add('Heavy rain / poor traction', step(w.precip, T.rainRateMmH) * 1.15, `${(w.precip ?? 0).toFixed(1)} mm/h expected`);
  add('Strong crosswinds', step(w.gust, T.gustKmh) * 1.1, `gusts ${Math.round(w.gust ?? 0)} km/h`);
  add('Low visibility', step(w.visibility, T.visibilityM, true) * 1.3, `visibility ${Math.round(w.visibility ?? 0)} m`);
  add('Heat in a stalled vehicle', step(w.apparent, T.heatApparentC) * 0.7, `feels like ${Math.round(w.apparent ?? 0)}°C`);
  return out.map((h) => ({ ...h, severity: Math.min(1, h.severity) }));
}

export async function analyseJourney({ from, to, toLabel, depart = Date.now(), demo, reports = [] }) {
  const limits = [
    'Weather along the route is forecast model data at roughly 10 km resolution. Small storms and local flooding may not appear.',
    'Road closures from authorities are not connected in this prototype. Check your local traffic authority before you travel.',
    'Routing uses the public OSRM demo server, which does not know about current road conditions.',
  ];
  const routes = await fetchRoutes(from, to);
  const allPts = routes.map((r) => samplePoints(r, depart));
  const flat = allPts.flat();

  let weather; let weatherError = null;
  try { weather = demo ? demoWeatherAt(flat, demo.grid) : await weatherAt(flat); }
  catch (e) { weatherError = e.message; limits.unshift(`Route weather is unavailable: ${e.message}. The rating below only reflects crossings and reports.`); }

  // Fords and official warnings are best-effort; failures reduce coverage and are reported.
  const fordResults = await Promise.allSettled(routes.map((r) => (demo ? Promise.resolve([]) : fordsAlongRoute(r.coords))));
  let destWarnings = [];
  if (demo) destWarnings = demo.warnings;
  else {
    try {
      const mid = routes[0].coords[Math.floor(routes[0].coords.length / 2)];
      const sets = await Promise.all([to, mid].map((p) => server.warnings(p.lat, p.lon).catch(() => null)));
      destWarnings = sets.filter(Boolean).flatMap((s) => s.warnings);
      if (sets.every((s) => !s || s.coverage === 'none')) limits.push('No official warnings feed is connected for this region.');
    } catch { limits.push('Official warnings could not be checked along this route.'); }
  }

  let wi = 0;
  const analysed = routes.map((r, ri) => {
    const pts = allPts[ri]; const hazards = [];
    pts.forEach((p) => {
      const w = weather ? weather[wi] : null; wi++;
      if (w) scoreSample(w).forEach((h) => hazards.push({ ...h, lat: p.lat, lon: p.lon, eta: p.eta }));
    });
    const fords = fordResults[ri].status === 'fulfilled' ? fordResults[ri].value : [];
    if (fordResults[ri].status === 'rejected' && !demo) limits.push('Low-water crossing data could not be loaded for every route.');
    const wetRoute = hazards.some((h) => h.label.startsWith('Heavy rain') && h.severity >= 0.4);
    fords.forEach((f) => hazards.push({ label: 'Low-water crossing (ford)', severity: wetRoute ? 0.75 : 0.3, detail: wetRoute ? 'Mapped ford on this route while heavy rain is expected. Fords flood quickly.' : 'Mapped ford on this route. Do not cross if water is flowing over it.', lat: f.lat, lon: f.lon }));
    const step2 = Math.max(1, Math.floor(r.coords.length / 300));
    const simp = r.coords.filter((_, i) => i % step2 === 0);
    const onRoute = reports.filter((rep) => ['flooded_road', 'fallen_tree', 'building_damage', 'strong_wind', 'hail'].includes(rep.category)
      && !['rejected', 'expired', 'resolved'].includes(rep.status) && distToPolylineM(rep, simp) < 300);
    onRoute.forEach((rep) => hazards.push({
      label: `Community report: ${rep.categoryLabel}`, severity: rep.category === 'flooded_road' ? (rep.status === 'verified' ? 0.85 : 0.6) : rep.status === 'verified' ? 0.5 : 0.35,
      detail: `${rep.status === 'verified' ? 'Verified' : 'Unverified'} report: ${rep.description}`, lat: rep.lat, lon: rep.lon, community: true,
    }));
    destWarnings.forEach((o) => hazards.push({ label: `Official: ${o.event}`, severity: RISK_CONFIG.officialSeverity[o.severity] ?? 0.4, detail: o.headline, official: true, source: o.sourceName }));

    hazards.sort((a, b) => b.severity - a.severity);
    const maxSev = hazards[0]?.severity || 0;
    return { ...r, rating: rate(maxSev), maxSev, hazards, fords, samples: pts.length };
  });

  const best = [...analysed].sort((a, b) => a.maxSev - b.maxSev || a.duration - b.duration)[0];
  const primary = analysed[0];
  const reasons = [];
  if (best.id !== primary.id) {
    const primaryLabels = new Set(primary.hazards.filter((h) => h.severity >= 0.3).map((h) => h.label));
    const bestLabels = new Set(best.hazards.filter((h) => h.severity >= 0.3).map((h) => h.label));
    const avoided = [...primaryLabels].filter((l) => !bestLabels.has(l));
    reasons.push(`Alternative ${best.id + 1} has a lower hazard rating (${best.rating.rating} instead of ${primary.rating.rating}).`);
    if (avoided.length) reasons.push(`It avoids: ${avoided.join(', ').toLowerCase()}.`);
    const extra = Math.round((best.duration - primary.duration) / 60);
    reasons.push(extra > 0 ? `It takes about ${extra} min longer.` : 'It is not slower than the fastest route.');
  }
  if (routes.length === 1) limits.push('The router returned only one route, so no alternative can be compared.');
  return { from, to, toLabel, depart, routes: analysed, recommendedId: best.id, reasons, limits: [...new Set(limits)], weatherError, computedAt: Date.now(), demo: Boolean(demo) };
}
