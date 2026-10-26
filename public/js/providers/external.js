// RainViewer radar, OSRM routing, and the StormShield server API (warnings + reports).
import { fetchJson, clientId, ProviderError } from '../util.js';

/** Latest radar frame from RainViewer (composite of national radars, ~10 minute cadence). */
export async function radarFrame() {
  const j = await fetchJson('https://api.rainviewer.com/public/weather-maps.json', { ttl: 5 * 60_000, provider: 'RainViewer radar' });
  const frames = j.radar?.past || [];
  if (!frames.length) throw new ProviderError('RainViewer returned no radar frames');
  const last = frames[frames.length - 1];
  return { host: j.host, path: last.path, time: last.time * 1000, provider: 'RainViewer' };
}

/** Driving routes with alternatives from the public OSRM demo server. */
export async function routes(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&alternatives=3&steps=false`;
  const j = await fetchJson(url, { ttl: 5 * 60_000, timeout: 20000, provider: 'OSRM routing' });
  if (j.code !== 'Ok' || !j.routes?.length) throw new ProviderError(j.message || 'No route found between these points', { provider: 'OSRM routing' });
  return j.routes.map((r, i) => ({
    id: i, distance: r.distance, duration: r.duration,
    coords: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
  }));
}

// ---------- StormShield backend ----------
async function api(path, opts = {}) {
  return fetchJson(path, { provider: 'StormShield server', timeout: 15000, ...opts });
}

export const server = {
  health: () => api('/api/health'),
  warnings: (lat, lon) => api(`/api/warnings?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { timeout: 30000 }),
  reports: (lat, lon, radiusKm = 30) => api(`/api/reports?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radiusKm=${radiusKm}&clientId=${encodeURIComponent(clientId())}`),
  mine: () => api(`/api/reports/mine?clientId=${encodeURIComponent(clientId())}`),
  submit: async (body) => {
    // Use raw fetch so we can surface 4xx validation messages to the form.
    const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, clientId: clientId() }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(json.error || `Submission failed (${res.status})`, { status: res.status });
    return json;
  },
  vote: async (id, kind) => {
    const res = await fetch(`/api/reports/${id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: clientId() }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(json.error || `Action failed (${res.status})`, { status: res.status });
    return json;
  },
  photoUrl: (id) => `/api/reports/${id}/photo?clientId=${encodeURIComponent(clientId())}`,
  admin: {
    list: (token) => api('/api/admin/reports', { init: { headers: { Authorization: `Bearer ${token}` } } }),
    set: async (token, id, status, note) => {
      const res = await fetch(`/api/admin/reports/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status, note }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(json.error || `Moderation failed (${res.status})`, { status: res.status });
      return json;
    },
  },
};
