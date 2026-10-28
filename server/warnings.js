// Official warnings adapters. Each adapter returns warnings in one normalised shape,
// keeping the issuing authority's ORIGINAL wording and severity.
//
//   { id, source, sourceName, event, headline, description, instruction,
//     severity, urgency, certainty, onset, expires, areaDesc, url,
//     geometry (GeoJSON or null), geoMatched, fetchedAt }
import { config } from './config.js';

const cache = new Map(); // key -> { at, value }
const TTL = 5 * 60_000;

async function fetchWithTimeout(url, opts = {}, ms = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// ---------- US National Weather Service (keyless, US only) ----------
const inUS = (lat, lon) => (lat > 18 && lat < 72 && lon > -180 && lon < -64) || (lat > 13 && lat < 15 && lon > 144 && lon < 146);

async function nws(lat, lon) {
  if (!inUS(lat, lon)) return { status: 'not_applicable', note: 'NWS covers the United States only.' };
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': config.nwsUserAgent, Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS responded ${res.status}`);
  const json = await res.json();
  const now = Date.now();
  return {
    status: 'ok',
    warnings: (json.features || []).map((f) => {
      const p = f.properties || {};
      return {
        id: p.id || f.id, source: 'nws', sourceName: p.senderName || 'US National Weather Service',
        event: p.event, headline: p.headline, description: p.description, instruction: p.instruction,
        severity: p.severity || 'Unknown', urgency: p.urgency, certainty: p.certainty,
        onset: p.onset || p.effective, expires: p.ends || p.expires, areaDesc: p.areaDesc,
        url: p['@id'] || null, geometry: f.geometry || null, geoMatched: true, fetchedAt: now,
      };
    }),
  };
}

// ---------- OpenWeather One Call 3.0 (key required, many countries) ----------
async function openWeather(lat, lon) {
  if (!config.openWeatherKey) return { status: 'not_configured', note: 'Set OPENWEATHER_API_KEY to enable.' };
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily,current&appid=${config.openWeatherKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`OpenWeather responded ${res.status}`);
  const json = await res.json();
  const now = Date.now();
  return {
    status: 'ok',
    warnings: (json.alerts || []).map((a, i) => ({
      id: `ow-${a.start}-${i}`, source: 'openweather', sourceName: a.sender_name || 'National agency via OpenWeather',
      event: a.event, headline: a.event, description: a.description, instruction: null,
      severity: 'Unknown', urgency: null, certainty: null,
      onset: new Date(a.start * 1000).toISOString(), expires: new Date(a.end * 1000).toISOString(),
      areaDesc: null, url: null, geometry: null, geoMatched: true, fetchedAt: now,
    })),
  };
}

// ---------- Generic CAP 1.2 feeds (RSS/Atom index or a single CAP document) ----------
const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return m ? decode(m[1].trim()) : null;
};
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi'))].map((m) => decode(m[1].trim()));
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function parseCap(xml, sourceName, lat, lon) {
  const infos = tags(xml, 'info');
  const info = infos.find((i) => /<(?:\w+:)?language>\s*en/i.test(i)) || infos[0];
  if (!info) return null;
  const expires = tag(info, 'expires');
  if (expires && Date.parse(expires) < Date.now()) return null;
  const areas = tags(info, 'area');
  let geoMatched = null; const rings = [];
  for (const a of areas) {
    for (const poly of tags(a, 'polygon')) {
      const ring = poly.split(/\s+/).map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (ring.length >= 3) { rings.push(ring); if (pointInPolygon(lat, lon, ring)) geoMatched = true; else if (geoMatched === null) geoMatched = false; }
    }
    for (const circ of tags(a, 'circle')) {
      const [c, r] = circ.split(/\s+/); const [clat, clon] = c.split(',').map(Number);
      const km = Number(r);
      const d = Math.hypot((clat - lat) * 111, (clon - lon) * 111 * Math.cos((lat * Math.PI) / 180));
      if (d <= km) geoMatched = true; else if (geoMatched === null) geoMatched = false;
    }
  }
  if (geoMatched === false) return null; // has geometry that excludes this location
  return {
    id: tag(xml, 'identifier') || Math.random().toString(36).slice(2), source: 'cap',
    sourceName: tag(info, 'senderName') || sourceName,
    event: tag(info, 'event'), headline: tag(info, 'headline') || tag(info, 'event'),
    description: tag(info, 'description'), instruction: tag(info, 'instruction'),
    severity: tag(info, 'severity') || 'Unknown', urgency: tag(info, 'urgency'), certainty: tag(info, 'certainty'),
    onset: tag(info, 'onset') || tag(info, 'effective') || tag(xml, 'sent'), expires,
    areaDesc: areas.map((a) => tag(a, 'areaDesc')).filter(Boolean).join('; ') || null,
    url: tag(info, 'web'),
    geometry: rings.length ? { type: 'MultiPolygon', coordinates: rings.map((r) => [r.map(([y, x]) => [x, y])]) } : null,
    // null = the alert has no geometry, so it is listed as regional rather than matched to you.
    geoMatched: geoMatched === true, fetchedAt: Date.now(),
  };
}

async function capFeed(url, lat, lon) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  const xml = await res.text();
  const feedTitle = tag(xml, 'title') || new URL(url).hostname;
  if (/<(?:\w+:)?alert[\s>]/i.test(xml)) {
    const w = parseCap(xml, feedTitle, lat, lon);
    return { status: 'ok', warnings: w ? [w] : [] };
  }
  const items = [...tags(xml, 'item'), ...tags(xml, 'entry')].slice(0, 40);
  const links = items.map((it) => {
    const href = /<link[^>]*href="([^"]+)"/i.exec(it);
    return href ? href[1] : tag(it, 'link');
  }).filter(Boolean);
  const results = await Promise.allSettled(links.map(async (l) => {
    const r = await fetchWithTimeout(l, {}, 8000);
    return r.ok ? parseCap(await r.text(), feedTitle, lat, lon) : null;
  }));
  return { status: 'ok', warnings: results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean) };
}

export async function getWarnings(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true };

  const adapters = [
    { id: 'nws', name: 'US National Weather Service', run: () => nws(lat, lon) },
    { id: 'openweather', name: 'OpenWeather government alerts', run: () => openWeather(lat, lon) },
    ...config.capFeeds.map((u, i) => ({ id: `cap${i}`, name: `CAP feed: ${new URL(u).hostname}`, run: () => capFeed(u, lat, lon) })),
  ];
  const sources = []; const warnings = [];
  await Promise.all(adapters.map(async (a) => {
    try {
      const r = await a.run();
      sources.push({ id: a.id, name: a.name, status: r.status, note: r.note || null, count: r.warnings?.length || 0, updatedAt: Date.now() });
      if (r.warnings) warnings.push(...r.warnings);
    } catch (e) {
      sources.push({ id: a.id, name: a.name, status: 'error', note: e.name === 'AbortError' ? 'Timed out' : e.message, count: 0, updatedAt: Date.now() });
    }
  }));
  const value = { sources, warnings, coverage: sources.some((s) => s.status === 'ok') ? 'connected' : 'none' };
  cache.set(key, { at: Date.now(), value });
  return value;
}
