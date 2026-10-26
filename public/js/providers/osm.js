// OpenStreetMap adapters: Nominatim (search / reverse) and Overpass (facilities, waterways, fords).
// Public instances have fair-use limits; see docs/DATA_PROVIDERS.md before deploying.
import { fetchJson, haversineM, distToPolylineM, ProviderError } from '../util.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function searchPlaces(q) {
  try {
    const j = await fetchJson(`${NOMINATIM}/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`, { ttl: 3600_000, provider: 'OpenStreetMap search' });
    return j.map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon), type: r.type }));
  } catch (e) {
    // Fallback: Open-Meteo geocoding (towns and cities only)
    const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=6&name=${encodeURIComponent(q)}`, { ttl: 3600_000, provider: 'Open-Meteo geocoding' });
    if (!j.results) throw e;
    return j.results.map((r) => ({ name: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, type: 'place' }));
  }
}

export async function reverseName(lat, lon) {
  const j = await fetchJson(`${NOMINATIM}/reverse?format=jsonv2&zoom=14&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { ttl: 3600_000, provider: 'OpenStreetMap reverse geocoding' });
  const a = j.address || {};
  const name = [a.suburb || a.neighbourhood || a.village || a.town || a.hamlet, a.city || a.town || a.county, a.country].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 3).join(', ') || j.display_name;
  return { name, cc: (a.country_code || '').toLowerCase() || null };
}

async function overpass(query, ttl = 30 * 60_000) {
  let lastErr;
  for (const base of OVERPASS) {
    try {
      return await fetchJson(base, { ttl, timeout: 25000, provider: 'Overpass (OpenStreetMap)', init: { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new ProviderError('Overpass unavailable');
}

const RESOURCE_TYPES = {
  hospital: { label: 'Hospital', group: 'emergency' },
  clinic: { label: 'Clinic', group: 'emergency', note: 'May not offer emergency care' },
  police: { label: 'Police station', group: 'emergency' },
  fire_station: { label: 'Fire station', group: 'emergency' },
  ambulance_station: { label: 'Ambulance station', group: 'emergency' },
  disaster_response: { label: 'Disaster management', group: 'emergency' },
  shelter: { label: 'Emergency shelter', group: 'community' },
  assembly_point: { label: 'Evacuation / assembly point', group: 'community' },
};
export { RESOURCE_TYPES };

function classify(t) {
  if (t.amenity === 'hospital' || t.healthcare === 'hospital') return 'hospital';
  if (t.amenity === 'clinic') return 'clinic';
  if (t.amenity === 'police') return 'police';
  if (t.amenity === 'fire_station') return 'fire_station';
  if (t.emergency === 'ambulance_station') return 'ambulance_station';
  if (t.emergency === 'disaster_response' || t['emergency_service'] === 'disaster_management') return 'disaster_response';
  if (t.social_facility === 'shelter' || t.amenity === 'refugee_site' || t.emergency === 'shelter') return 'shelter';
  if (t.emergency === 'assembly_point') return 'assembly_point';
  return null;
}

/** Emergency facilities near a point (mapped OSM data; operating status is not known). */
export async function emergencyResources(lat, lon, radiusM = 15000) {
  const a = `(around:${radiusM},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const q = `[out:json][timeout:25];(
    nwr["amenity"~"^(hospital|clinic|police|fire_station|refugee_site)$"]${a};
    nwr["healthcare"="hospital"]${a};
    nwr["emergency"~"^(ambulance_station|assembly_point|disaster_response|shelter)$"]${a};
    nwr["social_facility"="shelter"]${a};
  );out center tags 400;`;
  const j = await overpass(q);
  const seen = new Set();
  return (j.elements || []).map((e) => {
    const t = e.tags || {}; const type = classify(t);
    const plat = e.lat ?? e.center?.lat, plon = e.lon ?? e.center?.lon;
    if (!type || plat == null) return null;
    const key = type + (t.name || '') + plat.toFixed(3) + plon.toFixed(3);
    if (seen.has(key)) return null; seen.add(key);
    const addr = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'], t['addr:city']].filter(Boolean).join(' ');
    return {
      id: `${e.type}/${e.id}`, type, ...RESOURCE_TYPES[type], name: t.name || t.operator || RESOURCE_TYPES[type].label,
      named: Boolean(t.name), lat: plat, lon: plon, distance: haversineM({ lat, lon }, { lat: plat, lon: plon }),
      address: addr || null, phone: t.phone || t['contact:phone'] || null, website: t.website || t['contact:website'] || null,
      emergencyDept: t.emergency === 'yes' ? true : t.emergency === 'no' ? false : null,
      openingHours: t.opening_hours || null, osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      source: 'OpenStreetMap', verification: 'mapped',
    };
  }).filter(Boolean).sort((x, y) => x.distance - y.distance);
}

/** Waterways and fords near a point, used for flood exposure. */
export async function terrainContext(lat, lon) {
  const q = `[out:json][timeout:20];(
    way["waterway"~"^(river|stream|canal|drain)$"](around:800,${lat.toFixed(4)},${lon.toFixed(4)});
    nwr["ford"~"^(yes|stepping_stones)$"](around:5000,${lat.toFixed(4)},${lon.toFixed(4)});
    way["natural"="water"]["water"~"^(river|reservoir)$"](around:500,${lat.toFixed(4)},${lon.toFixed(4)});
  );out geom 80;`;
  const j = await overpass(q, 6 * 3600_000);
  let nearest = Infinity; let nearestName = null; let nearestKind = null;
  const fords = [];
  for (const e of j.elements || []) {
    const t = e.tags || {};
    if (t.ford) {
      const p = e.lat != null ? { lat: e.lat, lon: e.lon } : e.geometry?.[0];
      if (p) fords.push({ id: `${e.type}/${e.id}`, lat: p.lat, lon: p.lon, name: t.name || null, distance: haversineM({ lat, lon }, p) });
      continue;
    }
    if (e.geometry?.length) {
      const d = distToPolylineM({ lat, lon }, e.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));
      if (d < nearest) { nearest = d; nearestName = t.name || null; nearestKind = t.waterway || t.water; }
    }
  }
  return { nearestWaterwayM: Number.isFinite(nearest) ? nearest : null, nearestWaterwayName: nearestName, nearestWaterwayKind: nearestKind, fords: fords.sort((a, b) => a.distance - b.distance), updatedAt: Date.now() };
}

/** Fords (low-water crossings) close to a route polyline. */
export async function fordsAlongRoute(coords) {
  const lats = coords.map((c) => c.lat), lons = coords.map((c) => c.lon);
  const bbox = [Math.min(...lats) - 0.01, Math.min(...lons) - 0.01, Math.max(...lats) + 0.01, Math.max(...lons) + 0.01].map((v) => v.toFixed(4)).join(',');
  const j = await overpass(`[out:json][timeout:25];nwr["ford"="yes"](${bbox});out center 300;`, 6 * 3600_000);
  const step = Math.max(1, Math.floor(coords.length / 400));
  const simplified = coords.filter((_, i) => i % step === 0);
  return (j.elements || []).map((e) => ({ id: `${e.type}/${e.id}`, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, name: e.tags?.name || null }))
    .filter((f) => f.lat != null && distToPolylineM(f, simplified) < 60);
}
