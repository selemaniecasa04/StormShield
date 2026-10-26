// Open-Meteo adapters (keyless, global): forecast, air quality, river discharge (GloFAS).
// All responses are normalised to plain objects with unix-ms timestamps.
import { fetchJson } from '../util.js';

const FC = 'https://api.open-meteo.com/v1/forecast';
const AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FLOOD = 'https://flood-api.open-meteo.com/v1/flood';

const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const HOURLY = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cape,uv_index,visibility';

const r4 = (n) => Math.round(n * 1e4) / 1e4;

function hourlySeries(h, from = Date.now() - 3600_000, hours = 24) {
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const t = h.time[i] * 1000;
    if (t < from) continue;
    if (out.length >= hours) break;
    out.push({
      time: t, temp: h.temperature_2m?.[i], apparent: h.apparent_temperature?.[i],
      precipProb: h.precipitation_probability?.[i], precip: h.precipitation?.[i], code: h.weather_code?.[i],
      wind: h.wind_speed_10m?.[i], gust: h.wind_gusts_10m?.[i], windDir: h.wind_direction_10m?.[i],
      cape: h.cape?.[i], uv: h.uv_index?.[i], visibility: h.visibility?.[i],
    });
  }
  return out;
}

/** Point forecast for the user's location. Model data: updates roughly hourly. */
export async function forecast(lat, lon) {
  const url = `${FC}?latitude=${r4(lat)}&longitude=${r4(lon)}&current=${CURRENT}&hourly=${HOURLY}&daily=uv_index_max,temperature_2m_max,apparent_temperature_max,precipitation_sum&forecast_days=3&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh`;
  const j = await fetchJson(url, { ttl: 10 * 60_000, provider: 'Open-Meteo forecast' });
  const c = j.current;
  const hourly = hourlySeries(j.hourly, Date.now() - 3600_000, 30);
  const nowHour = hourly[0] || {};
  return {
    provider: 'Open-Meteo (blend of national weather models)',
    kind: 'model',
    elevation: j.elevation, timezone: j.timezone,
    current: {
      time: c.time * 1000, temp: c.temperature_2m, apparent: c.apparent_temperature, humidity: c.relative_humidity_2m,
      isDay: c.is_day === 1, precip: c.precipitation, rain: c.rain, showers: c.showers, code: c.weather_code,
      cloud: c.cloud_cover, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, windDir: c.wind_direction_10m,
      cape: nowHour.cape, uv: nowHour.uv, visibility: nowHour.visibility, precipProb: nowHour.precipProb,
    },
    hourly,
    daily: (j.daily?.time || []).map((t, i) => ({
      time: t * 1000, uvMax: j.daily.uv_index_max?.[i], tempMax: j.daily.temperature_2m_max?.[i],
      apparentMax: j.daily.apparent_temperature_max?.[i], precipSum: j.daily.precipitation_sum?.[i],
    })),
    updatedAt: c.time * 1000,
  };
}

/** Grid of points around a centre, for map overlays. size x size points, `step` degrees apart. */
export function gridPoints(lat, lon, size = 5, step = 0.12) {
  const pts = []; const half = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    pts.push({ lat: r4(lat + (y - half) * step), lon: r4(lon + (x - half) * step * 1 / Math.max(0.3, Math.cos(lat * Math.PI / 180))) });
  }
  return { pts, step, stepLon: step / Math.max(0.3, Math.cos(lat * Math.PI / 180)) };
}

export async function forecastGrid(points) {
  const lats = points.map((p) => p.lat).join(','), lons = points.map((p) => p.lon).join(',');
  const url = `${FC}?latitude=${lats}&longitude=${lons}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m&hourly=precipitation,weather_code,wind_gusts_10m,precipitation_probability&forecast_hours=6&timeformat=unixtime&wind_speed_unit=kmh`;
  const j = await fetchJson(url, { ttl: 10 * 60_000, provider: 'Open-Meteo grid' });
  const arr = Array.isArray(j) ? j : [j];
  return arr.map((d, i) => {
    const h = d.hourly || {};
    const codes = h.weather_code || [];
    return {
      lat: points[i].lat, lon: points[i].lon, elevation: d.elevation,
      temp: d.current?.temperature_2m, apparent: d.current?.apparent_temperature,
      precip: d.current?.precipitation, code: d.current?.weather_code,
      wind: d.current?.wind_speed_10m, gust: d.current?.wind_gusts_10m, windDir: d.current?.wind_direction_10m,
      precip6h: (h.precipitation || []).reduce((a, b) => a + (b || 0), 0),
      gust6h: Math.max(d.current?.wind_gusts_10m || 0, ...(h.wind_gusts_10m || []).map((g) => g || 0)),
      thunder6h: codes.some((c) => c >= 95), hail6h: codes.some((c) => c === 96 || c === 99),
      time: (d.current?.time || 0) * 1000,
    };
  });
}

/** Air quality (CAMS). Model data, hourly. */
export async function airQuality(lat, lon) {
  const url = `${AQ}?latitude=${r4(lat)}&longitude=${r4(lon)}&current=us_aqi,european_aqi,pm2_5,pm10,dust,aerosol_optical_depth,uv_index&hourly=us_aqi&forecast_days=1&timeformat=unixtime`;
  const j = await fetchJson(url, { ttl: 20 * 60_000, provider: 'Open-Meteo air quality' });
  const c = j.current;
  const next = (j.hourly?.time || []).map((t, i) => ({ time: t * 1000, aqi: j.hourly.us_aqi[i] })).filter((x) => x.time >= Date.now() - 3600_000).slice(0, 12);
  return {
    provider: 'Open-Meteo / Copernicus CAMS', kind: 'model',
    usAqi: c.us_aqi, euAqi: c.european_aqi, pm25: c.pm2_5, pm10: c.pm10, dust: c.dust, aod: c.aerosol_optical_depth, uv: c.uv_index,
    maxNext12h: Math.max(...next.map((x) => x.aqi ?? 0), c.us_aqi ?? 0),
    updatedAt: c.time * 1000,
  };
}

export async function airQualityGrid(points) {
  const url = `${AQ}?latitude=${points.map((p) => p.lat).join(',')}&longitude=${points.map((p) => p.lon).join(',')}&current=us_aqi,dust&timeformat=unixtime`;
  const j = await fetchJson(url, { ttl: 20 * 60_000, provider: 'Open-Meteo air quality grid' });
  return (Array.isArray(j) ? j : [j]).map((d, i) => ({ lat: points[i].lat, lon: points[i].lon, usAqi: d.current?.us_aqi, dust: d.current?.dust }));
}

/**
 * River discharge at the nearest GloFAS river cell (~5 km grid).
 * We compare the 7-day forecast peak against the median of the previous 180 days.
 * This is an estimate of unusual river flow, not an official flood warning.
 */
export async function riverDischarge(lat, lon) {
  const url = `${FLOOD}?latitude=${r4(lat)}&longitude=${r4(lon)}&daily=river_discharge&past_days=180&forecast_days=7&timeformat=unixtime`;
  const j = await fetchJson(url, { ttl: 60 * 60_000, provider: 'Open-Meteo flood (GloFAS)' });
  const t = j.daily?.time || [], q = j.daily?.river_discharge || [];
  const today = Date.now() - 86400_000;
  const past = [], future = [];
  t.forEach((ts, i) => { if (q[i] == null) return; (ts * 1000 < today ? past : future).push({ time: ts * 1000, q: q[i] }); });
  if (!past.length || !future.length) return { provider: 'GloFAS via Open-Meteo', kind: 'model', available: false, reason: 'No river cell with data near this location.' };
  const sorted = past.map((p) => p.q).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const peak = future.reduce((m, f) => (f.q > m.q ? f : m), future[0]);
  return {
    provider: 'GloFAS via Open-Meteo', kind: 'model', available: median > 0.5,
    reason: median > 0.5 ? null : 'Nearest modelled river cell carries very little flow.',
    median, p95, peak: peak.q, peakTime: peak.time, now: future[0].q,
    ratio: median > 0 ? peak.q / median : null, aboveP95: peak.q > p95,
    series: future, updatedAt: Date.now(),
  };
}
