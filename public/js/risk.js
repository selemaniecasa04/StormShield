// StormShield risk engine.
//
// Each hazard is scored on its own as a SEVERITY between 0 and 1 using fixed
// thresholds (RISK_CONFIG.thresholds). Severity is then adjusted for EXPOSURE
// (activity, proximity to water, night time) and for how the hazard is known
// (observed now vs forecast later). Hazards are combined with a "probabilistic OR"
// so the worst hazard always dominates and extra hazards add less:
//
//   combined = 1 - (1 - s1) * Π_{i>1} (1 - s_i * secondaryWeight)
//   preparedness score = round(100 * (1 - combined))      (100 = no threat found)
//
// Severity floors then guarantee that one critical hazard can never be averaged away:
// any hazard >= 0.85 forces EMERGENCY, >= 0.6 forces at least WARNING, >= 0.3 at least WATCH.
// Official warnings keep their own wording and severity; they only feed the score.
// Full rationale: docs/RISK_MODEL.md
import { isThunder, isHail, haversineM, clamp } from './util.js';

export const RISK_CONFIG = {
  secondaryWeight: 0.5,
  levels: [ // score lower bound -> level
    { min: 75, level: 'SAFE' }, { min: 50, level: 'WATCH' }, { min: 25, level: 'WARNING' }, { min: 0, level: 'EMERGENCY' },
  ],
  floors: [{ sev: 0.85, level: 'EMERGENCY' }, { sev: 0.6, level: 'WARNING' }, { sev: 0.3, level: 'WATCH' }],
  forecastDiscount: 0.85, // hazards expected within 6 h but not happening now
  thresholds: {
    rainRateMmH: [[2.5, 0.15], [7.6, 0.4], [20, 0.65], [50, 0.88]],
    rain6hMm: [[20, 0.25], [40, 0.45], [70, 0.7], [110, 0.88]],
    riverRatio: [[2, 0.3], [4, 0.55], [8, 0.8]],
    gustKmh: [[50, 0.15], [62, 0.3], [75, 0.48], [90, 0.68], [110, 0.88]],
    heatApparentC: [[32, 0.2], [38, 0.4], [41, 0.6], [46, 0.8], [54, 0.95]],
    coldApparentC: [[-10, 0.3], [-25, 0.6], [-40, 0.85]],   // values are "at or below"
    uvIndex: [[8, 0.2], [11, 0.35]],
    usAqi: [[101, 0.2], [151, 0.45], [201, 0.65], [301, 0.88]],
    visibilityM: [[1000, 0.3], [200, 0.6]],                // "at or below"
    capeJkg: [[1000, 0.2], [2500, 0.35]],
  },
  officialSeverity: { Extreme: 0.95, Severe: 0.75, Moderate: 0.45, Minor: 0.2, Unknown: 0.4 },
  communityBoost: { flooded_road: ['flood', 0.45], lightning: ['storm', 0.5], hail: ['hail', 0.45], strong_wind: ['wind', 0.3], fallen_tree: ['wind', 0.25] },
  communityRadiusM: 5000,
  exposure: {
    indoors:  { storm: 0.6, wind: 0.7, hail: 0.5, heat: 0.65, cold: 0.6, uv: 0.2, air: 0.75, flood: 0.9, visibility: 0.5 },
    outdoors: { storm: 1.15, wind: 1.1, hail: 1.15, heat: 1.15, cold: 1.1, uv: 1.15, air: 1.1, flood: 1.0, visibility: 0.9 },
    driving:  { storm: 0.85, wind: 1.1, hail: 1.0, heat: 0.8, cold: 0.9, uv: 0.4, air: 0.8, flood: 1.3, visibility: 1.3 },
    unknown:  {},
  },
};

const step = (value, table, below = false) => {
  if (value == null || !Number.isFinite(value)) return 0;
  let s = 0;
  for (const [t, sev] of table) if (below ? value <= t : value >= t) s = sev;
  return s;
};

const levelRank = { SAFE: 0, WATCH: 1, WARNING: 2, EMERGENCY: 3 };
const sevToLevel = (s) => (s >= 0.85 ? 'severe' : s >= 0.6 ? 'high' : s >= 0.3 ? 'moderate' : s > 0 ? 'low' : 'none');

/** Infer what the person is doing from speed, unless they chose it in Settings. */
export function resolveActivity(pref, location) {
  if (pref && pref !== 'auto') return { activity: pref, inferred: false };
  const v = location?.speed;
  if (v == null || !Number.isFinite(v)) return { activity: 'unknown', inferred: true };
  if (v > 7) return { activity: 'driving', inferred: true };
  if (v > 0.8) return { activity: 'outdoors', inferred: true };
  return { activity: 'unknown', inferred: true };
}

/**
 * @param c  conditions: { weather, air, river, terrain, grid, warnings, reports, location, now }
 * @param opts { activityPref }
 */
export function assess(c, opts = {}) {
  const cfg = RISK_CONFIG; const T = cfg.thresholds;
  const now = c.now || Date.now();
  const w = c.weather; const hazards = []; const gaps = [];
  const { activity, inferred } = resolveActivity(opts.activityPref, c.location);
  const exp = cfg.exposure[activity] || {};
  const night = w ? !w.current.isDay : false;

  if (!w) {
    return {
      level: 'UNKNOWN', score: null, confidence: 'low', hazards: [], activity, activityInferred: inferred,
      gaps: ['Weather data is unavailable, so StormShield cannot assess your risk. Check official sources and local news.'],
      computedAt: now,
    };
  }

  const cur = w.current;
  const next6 = w.hourly.filter((h) => h.time >= now - 1800_000 && h.time <= now + 6 * 3600_000);
  const next12 = w.hourly.filter((h) => h.time >= now - 1800_000 && h.time <= now + 12 * 3600_000);
  const basis = c.demo ? 'demo' : 'forecast-model';
  const src = c.demo ? 'Demonstration data' : w.provider;

  const add = (h) => {
    const e = exp[h.id] ?? 1;
    const severity = clamp(h.raw * e, 0, 1);
    if (severity <= 0.01) return;
    hazards.push({ ...h, exposure: e, severity, level: sevToLevel(severity) });
  };

  // ---- Thunderstorm / lightning ----
  {
    const nowThunder = isThunder(cur.code);
    const soon = next6.find((h) => isThunder(h.code));
    const capeMax = Math.max(0, ...next6.map((h) => h.cape || 0));
    const probMax = Math.max(0, ...next6.map((h) => h.precipProb || 0));
    let raw = 0, detail = '', when = 'now';
    if (nowThunder) { raw = 0.72; detail = 'Thunderstorm conditions are in the current model analysis for your location.'; }
    else if (soon) { raw = 0.6 * cfg.forecastDiscount; when = soon.time; detail = 'Thunderstorms are forecast within the next 6 hours.'; }
    else if (probMax >= 40) {
      const s = step(capeMax, T.capeJkg);
      if (s) { raw = s; when = 'later'; detail = `Atmosphere is unstable (CAPE up to ${Math.round(capeMax)} J/kg) with a ${probMax}% chance of rain. Storms could develop.`; }
    }
    const rep = nearbyReports(c, 'lightning', 2 * 3600_000);
    if (rep.length) { raw = Math.max(raw, cfg.communityBoost.lightning[1]); detail += ` ${rep.length} community report${rep.length > 1 ? 's' : ''} of lightning nearby (unverified unless marked).`; }
    if (raw) add({ id: 'storm', layer: 'storms', label: nowThunder ? 'Thunderstorm overhead' : 'Thunderstorm risk', raw, detail: detail.trim(), when, basis, source: src, value: capeMax ? `${Math.round(capeMax)} J/kg CAPE` : null });
    gaps.push('Live lightning-strike data is not connected. Lightning risk is estimated from forecast thunderstorm conditions.');
  }

  // ---- Hail ----
  {
    const nowHail = isHail(cur.code); const soon = next6.find((h) => isHail(h.code));
    let raw = nowHail ? 0.7 : soon ? 0.55 * cfg.forecastDiscount : 0;
    const rep = nearbyReports(c, 'hail', 3 * 3600_000);
    let detail = nowHail ? 'The current model analysis shows a thunderstorm with hail.' : soon ? 'Thunderstorms with hail are forecast within 6 hours.' : '';
    if (rep.length) { raw = Math.max(raw, cfg.communityBoost.hail[1]); detail += ` ${rep.length} community hail report${rep.length > 1 ? 's' : ''} nearby.`; }
    if (raw) add({ id: 'hail', layer: 'hail', label: 'Hail risk', raw, detail: detail.trim(), when: nowHail ? 'now' : soon?.time || 'now', basis, source: src, value: 'Hail size not available from this provider' });
  }

  // ---- Rain & flooding ----
  {
    const rate = cur.precip ?? 0;
    const sum6 = next6.reduce((a, h) => a + (h.precip || 0), 0);
    const sRate = step(rate, T.rainRateMmH);
    const s6 = step(sum6, T.rain6hMm) * cfg.forecastDiscount;
    let raw = Math.max(sRate, s6); const parts = [];
    if (sRate) parts.push(`Rain is falling at about ${rate.toFixed(1)} mm/h.`);
    if (s6) parts.push(`About ${Math.round(sum6)} mm of rain is forecast over the next 6 hours.`);
    let riverPart = null;
    const r = c.river;
    if (r?.available && r.ratio) {
      const sr = step(r.ratio, T.riverRatio);
      if (sr) { riverPart = `The nearest modelled river is forecast to peak at ${r.ratio.toFixed(1)}× its recent median flow.`; raw = Math.max(raw, sr); parts.push(riverPart); }
    }
    // Exposure: proximity to water and relative elevation
    let geoMult = 1; const geo = [];
    const tw = c.terrain?.nearestWaterwayM;
    if (tw != null && tw < 200) { geoMult *= 1.25; geo.push(`you are about ${Math.round(tw)} m from ${c.terrain.nearestWaterwayName || 'a ' + (c.terrain.nearestWaterwayKind || 'waterway')}`); }
    const rel = relativeElevation(c);
    if (rel != null && rel < -15) { geoMult *= 1.15; geo.push(`your location sits about ${Math.round(-rel)} m lower than the surrounding area`); }
    if (night) geoMult *= 1.1;
    const rep = nearbyReports(c, 'flooded_road', 6 * 3600_000);
    if (rep.length) { raw = Math.max(raw, cfg.communityBoost.flooded_road[1]); parts.push(`${rep.length} flooded-road report${rep.length > 1 ? 's' : ''} within ${Math.round(cfg.communityRadiusM / 1000)} km.`); }
    if (raw) {
      add({ id: 'flood', layer: 'flood', label: sRate >= 0.4 || s6 >= 0.4 || riverPart ? 'Flash-flood risk' : 'Heavy rain', raw: clamp(raw * geoMult, 0, 1),
        detail: parts.join(' ') + (geo.length ? ` Exposure is higher because ${geo.join(' and ')}.` : ''), when: sRate ? 'now' : 'later', basis, source: src,
        value: `${fmt1(rate)} mm/h now · ${Math.round(sum6)} mm next 6 h` });
    }
    if (!c.river) gaps.push('River-flow forecast unavailable.');
    if (!c.terrain) gaps.push('Waterway proximity unknown (OpenStreetMap lookup unavailable).');
  }

  // ---- Wind ----
  {
    const gNow = cur.gust ?? 0; const g6 = Math.max(0, ...next6.map((h) => h.gust || 0));
    const sNow = step(gNow, T.gustKmh), s6 = step(g6, T.gustKmh) * cfg.forecastDiscount;
    let raw = Math.max(sNow, s6);
    const rep = [...nearbyReports(c, 'strong_wind', 3 * 3600_000), ...nearbyReports(c, 'fallen_tree', 12 * 3600_000)];
    if (rep.length) raw = Math.max(raw, 0.3);
    if (raw) add({ id: 'wind', layer: 'wind', label: 'Damaging wind gusts', raw,
      detail: `Gusts of ${Math.round(gNow)} km/h now, up to ${Math.round(g6)} km/h in the next 6 hours.${rep.length ? ` ${rep.length} community report${rep.length > 1 ? 's' : ''} of wind damage nearby.` : ''}`,
      when: sNow >= s6 ? 'now' : 'later', basis, source: src, value: `${Math.round(Math.max(gNow, g6))} km/h peak gust` });
  }

  // ---- Heat / cold / UV ----
  {
    const aMax = Math.max(cur.apparent ?? -99, ...next12.map((h) => h.apparent ?? -99));
    const sHeat = step(aMax, T.heatApparentC);
    if (sHeat) add({ id: 'heat', layer: 'heat', label: 'Extreme heat', raw: sHeat, detail: `Feels-like temperature reaches ${Math.round(aMax)}°C in the next 12 hours.`, when: (cur.apparent ?? 0) >= aMax - 1 ? 'now' : 'later', basis, source: src, value: `${Math.round(aMax)}°C feels like` });
    const aMin = Math.min(cur.apparent ?? 99, ...next12.map((h) => h.apparent ?? 99));
    const sCold = step(aMin, T.coldApparentC, true);
    if (sCold) add({ id: 'cold', layer: 'heat', label: 'Dangerous cold', raw: sCold, detail: `Feels-like temperature drops to ${Math.round(aMin)}°C in the next 12 hours.`, when: 'later', basis, source: src, value: `${Math.round(aMin)}°C feels like` });
    const uv = cur.isDay ? Math.max(cur.uv ?? 0, ...next6.map((h) => h.uv ?? 0)) : 0;
    const sUv = step(uv, T.uvIndex);
    if (sUv) add({ id: 'uv', layer: 'heat', label: 'Very high UV', raw: sUv, detail: `UV index reaches ${uv.toFixed(0)} today.`, when: 'now', basis, source: src, value: `UV ${uv.toFixed(0)}` });
  }

  // ---- Air quality ----
  if (c.air) {
    const aqi = Math.max(c.air.usAqi ?? 0, c.air.maxNext12h ?? 0);
    const s = step(aqi, T.usAqi);
    const dusty = (c.air.dust ?? 0) > 150;
    if (s || dusty) add({ id: 'air', layer: 'air', label: dusty ? 'Dust and poor air' : 'Unhealthy air', raw: Math.max(s, dusty ? 0.3 : 0),
      detail: `US AQI is ${c.air.usAqi ?? '—'} now${c.air.maxNext12h > (c.air.usAqi ?? 0) ? `, rising to ${c.air.maxNext12h} in the next 12 hours` : ''}.${dusty ? ` Dust concentration is ${Math.round(c.air.dust)} µg/m³.` : ''}`,
      when: 'now', basis: c.demo ? 'demo' : 'forecast-model', source: c.demo ? 'Demonstration data' : c.air.provider, value: `AQI ${aqi}` });
  } else gaps.push('Air-quality data unavailable.');

  // ---- Visibility (fog, dust, heavy rain) ----
  {
    const vis = cur.visibility; const s = step(vis, T.visibilityM, true);
    if (s) add({ id: 'visibility', layer: 'air', label: 'Low visibility', raw: s, detail: `Visibility is about ${vis < 1000 ? Math.round(vis) + ' m' : (vis / 1000).toFixed(1) + ' km'}.`, when: 'now', basis, source: src, value: `${Math.round(vis)} m` });
  }

  // ---- Official warnings (kept verbatim; feed the score) ----
  const official = (c.warnings || []).filter((x) => !x.expires || Date.parse(x.expires) > now);
  for (const o of official) {
    const raw = (cfg.officialSeverity[o.severity] ?? 0.4) * (o.geoMatched ? 1 : 0.6);
    hazards.push({ id: 'official:' + o.id, layer: 'warnings', label: o.event || 'Official warning', raw, exposure: 1, severity: raw, level: sevToLevel(raw),
      detail: o.headline || o.event, when: o.onset ? Date.parse(o.onset) : 'now', basis: o.demo ? 'demo' : 'official', source: o.sourceName, official: o, value: `Official severity: ${o.severity}` });
  }
  if (c.warningsCoverage === 'none') gaps.push('No official warnings feed is connected for this region. Check your national weather service directly.');

  // ---- Combine ----
  hazards.sort((a, b) => b.severity - a.severity);
  const s1 = hazards[0]?.severity || 0;
  let rest = 1;
  hazards.slice(1).forEach((h) => { rest *= 1 - h.severity * cfg.secondaryWeight; });
  const combined = 1 - (1 - s1) * rest;
  const score = Math.round(100 * (1 - combined));
  let level = cfg.levels.find((l) => score >= l.min).level;
  for (const f of cfg.floors) if (s1 >= f.sev && levelRank[f.level] > levelRank[level]) { level = f.level; break; }
  const officialFloor = official.some((o) => o.severity === 'Extreme' && o.geoMatched) ? 'EMERGENCY' : official.some((o) => o.severity === 'Severe' && o.geoMatched) ? 'WARNING' : null;
  if (officialFloor && levelRank[officialFloor] > levelRank[level]) level = officialFloor;

  // ---- Confidence ----
  const ageH = (now - (w.updatedAt || now)) / 3600_000;
  let confidence = 'high'; const confReasons = [];
  if (ageH > 3) { confidence = 'low'; confReasons.push(`weather data is ${Math.round(ageH)} hours old`); }
  else if (ageH > 1.5) { confidence = 'medium'; confReasons.push('weather data is over an hour old'); }
  if (c.warningsCoverage === 'none') { if (confidence === 'high') confidence = 'medium'; confReasons.push('no official warnings feed for this region'); }
  if (!c.air || !c.river) { if (confidence === 'high') confidence = 'medium'; confReasons.push('some data sources are unavailable'); }
  if (c.location?.accuracy > 5000) { confidence = 'low'; confReasons.push('your location is only approximate'); }
  if (c.demo) { confidence = 'demo'; confReasons.splice(0, confReasons.length, 'demonstration data is active'); }

  return { level, score, combined, hazards, confidence, confReasons, activity, activityInferred: inferred, night, gaps, computedAt: now };
}

function nearbyReports(c, category, maxAgeMs) {
  if (!c.reports || !c.location) return [];
  const now = c.now || Date.now();
  return c.reports.filter((r) => r.category === category && !['rejected', 'expired', 'resolved'].includes(r.status)
    && now - r.observedAt < maxAgeMs && haversineM(c.location, r) < RISK_CONFIG.communityRadiusM);
}

function relativeElevation(c) {
  const g = c.grid?.filter((p) => p.elevation != null);
  if (!g?.length || c.weather?.elevation == null) return null;
  const mean = g.reduce((a, p) => a + p.elevation, 0) / g.length;
  return c.weather.elevation - mean;
}
const fmt1 = (n) => (n == null ? '—' : n.toFixed(1));

/** Human-readable reasons why the assessment changed. */
export function explainChange(prev, next) {
  if (!prev || next.score == null) return [];
  if (prev.score == null) return ['Weather data became available.'];
  const out = [];
  const pm = new Map(prev.hazards.map((h) => [h.id, h])), nm = new Map(next.hazards.map((h) => [h.id, h]));
  for (const [id, h] of nm) {
    const p = pm.get(id);
    if (!p) out.push(`New: ${h.label.toLowerCase()} (${h.level}).`);
    else if (h.level !== p.level) out.push(`${h.label} changed from ${p.level} to ${h.level}.`);
  }
  for (const [id, p] of pm) if (!nm.has(id)) out.push(`${p.label} is no longer detected.`);
  if (!out.length && Math.abs(next.score - prev.score) >= 5) out.push('Forecast values shifted slightly.');
  return out;
}

export { levelRank };
