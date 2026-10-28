// Shared helpers: networking with timeouts and caching, geometry, formatting.

const memCache = new Map();

export class ProviderError extends Error {
  constructor(message, { status, provider, timeout } = {}) {
    super(message); this.status = status; this.provider = provider; this.timeout = timeout;
  }
}

/** fetch JSON with timeout, in-memory TTL cache and one retry on 429/5xx. */
export async function fetchJson(url, { ttl = 0, timeout = 12000, provider = 'provider', init } = {}) {
  if (ttl) {
    const hit = memCache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
  }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ProviderError(res.status === 429 ? `${provider} rate limit reached` : `${provider} is unavailable (${res.status})`, { status: res.status, provider });
        await sleep(1200 * (attempt + 1));
        continue;
      }
      const isJson = (res.headers.get('content-type') || '').includes('json');
      const body = isJson ? await res.json() : await res.text();
      if (!res.ok) throw new ProviderError((body && body.error) || (body && body.reason) || `${provider} returned ${res.status}`, { status: res.status, provider });
      if (ttl) memCache.set(url, { at: Date.now(), value: body });
      return body;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      lastErr = new ProviderError(e.name === 'AbortError' ? `${provider} timed out` : `${provider} could not be reached`, { provider, timeout: e.name === 'AbortError' });
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distance in metres from point p to segment ab (equirectangular approximation, fine for < 50 km). */
export function distToSegmentM(p, a, b) {
  const k = 111320, cos = Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lon - p.lon) * k * cos, ay = (a.lat - p.lat) * k;
  const bx = (b.lon - p.lon) * k * cos, by = (b.lat - p.lat) * k;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function distToPolylineM(p, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) best = Math.min(best, distToSegmentM(p, coords[i - 1], coords[i]));
  return coords.length === 1 ? haversineM(p, coords[0]) : best;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function timeAgo(ts) {
  if (!ts) return 'unknown time';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return 'in ' + timeAgo(Date.now() + (Date.now() - ts)).replace(' ago', '');
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const dateTime = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---- Units ----
let units = 'metric';
export const setUnits = (u) => { units = u; };
export const getUnits = () => units;
export const fmtTemp = (c) => (c == null ? '—' : units === 'imperial' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
export const fmtSpeed = (kmh) => (kmh == null ? '—' : units === 'imperial' ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`);
export const fmtPrecip = (mm) => (mm == null ? '—' : units === 'imperial' ? `${(mm / 25.4).toFixed(2)} in` : `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`);
export function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (units === 'imperial') { const mi = m / 1609.34; return mi < 0.2 ? `${Math.round(m * 3.28084)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`; }
  return m < 1000 ? `${Math.round(m)} m` : `${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}
export const compass = (deg) => (deg == null ? '' : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16]);

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem('ss.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('ss.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  clear() { try { Object.keys(localStorage).filter((k) => k.startsWith('ss.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } },
};

export function clientId() {
  let id = store.get('clientId');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('clientId', id); }
  return id;
}

/** WMO weather interpretation codes used by Open-Meteo. */
export const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};
export const isThunder = (c) => c === 95 || c === 96 || c === 99;
export const isHail = (c) => c === 96 || c === 99;
