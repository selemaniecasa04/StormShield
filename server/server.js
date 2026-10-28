// StormShield server: static hosting + reports API + official warnings proxy.
// Run with: node server/server.js   (Node 18+; no npm install needed)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loadReports, listReports, listMine, createReport, voteReport, moderate, adminList, photoFor, CATEGORIES } from './reports.js';
import { getWarnings } from './warnings.js';

loadReports();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://tilecache.rainviewer.com",
  "connect-src 'self' https://api.open-meteo.com https://air-quality-api.open-meteo.com https://flood-api.open-meteo.com https://geocoding-api.open-meteo.com https://nominatim.openstreetmap.org https://overpass-api.de https://overpass.kumi.systems https://router.project-osrm.org https://api.rainviewer.com",
].join('; ');

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 3_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
}

const isAdmin = (req) => Boolean(config.adminToken) && req.headers.authorization === `Bearer ${config.adminToken}`;
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

async function api(req, res, url) {
  const p = url.pathname; const q = url.searchParams;
  const num = (k) => (q.has(k) ? Number(q.get(k)) : NaN);

  if (p === '/api/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true, time: Date.now(), categories: CATEGORIES,
      moderation: Boolean(config.adminToken),
      warningSources: {
        nws: 'keyless (United States)',
        openweather: config.openWeatherKey ? 'configured' : 'not configured',
        capFeeds: config.capFeeds.length,
      },
    });
  }
  if (p === '/api/warnings' && req.method === 'GET') {
    const lat = num('lat'), lon = num('lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'lat and lon are required.' });
    return send(res, 200, await getWarnings(lat, lon));
  }
  if (p === '/api/reports' && req.method === 'GET') {
    return send(res, 200, { reports: listReports({ lat: num('lat'), lon: num('lon'), radiusKm: Number(q.get('radiusKm')) || 25, clientId: q.get('clientId') }) });
  }
  if (p === '/api/reports/mine' && req.method === 'GET') {
    return send(res, 200, { reports: listMine(q.get('clientId') || '') });
  }
  if (p === '/api/reports' && req.method === 'POST') {
    const r = createReport(await readJson(req), clientIp(req));
    return send(res, r.status, r.body);
  }
  let m;
  if ((m = /^\/api\/reports\/([\w-]+)\/(confirm|clear)$/.exec(p)) && req.method === 'POST') {
    const body = await readJson(req, 10_000);
    const r = voteReport(m[1], m[2], body.clientId, clientIp(req));
    return send(res, r.status, r.body);
  }
  if ((m = /^\/api\/reports\/([\w-]+)\/photo$/.exec(p)) && req.method === 'GET') {
    const f = photoFor(m[1], q.get('clientId'), isAdmin(req) || (config.adminToken && q.get('token') === config.adminToken));
    if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'Photo not available.' });
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=300' });
  }
  if (p === '/api/admin/reports' && req.method === 'GET') {
    if (!config.adminToken) return send(res, 403, { error: 'Moderation is disabled. Set ADMIN_TOKEN in .env and restart the server.' });
    if (!isAdmin(req)) return send(res, 401, { error: 'Moderator token is incorrect.' });
    return send(res, 200, { reports: adminList() });
  }
  if ((m = /^\/api\/admin\/reports\/([\w-]+)$/.exec(p)) && req.method === 'POST') {
    if (!config.adminToken) return send(res, 403, { error: 'Moderation is disabled. Set ADMIN_TOKEN in .env and restart the server.' });
    if (!isAdmin(req)) return send(res, 401, { error: 'Moderator token is incorrect.' });
    const body = await readJson(req, 10_000);
    const r = moderate(m[1], body.status, body.note);
    return send(res, r.status, r.body);
  }
  return send(res, 404, { error: 'Unknown API route.' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(self)', 'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: e.code ? e.message : 'Server error. Check the server log.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`StormShield running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Moderation: ${config.adminToken ? 'enabled' : 'disabled (set ADMIN_TOKEN)'} · CAP feeds: ${config.capFeeds.length} · OpenWeather alerts: ${config.openWeatherKey ? 'on' : 'off'}`);
});
