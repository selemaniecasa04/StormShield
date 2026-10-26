// Loads configuration from environment variables (and an optional .env file).
// No third-party dependencies: the server runs with plain `node`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  // Moderators use this token to verify, resolve or reject community reports.
  adminToken: process.env.ADMIN_TOKEN || '',
  // Contact string sent in the User-Agent to api.weather.gov (required by NWS policy).
  nwsUserAgent: process.env.NWS_USER_AGENT || 'StormShield prototype (set NWS_USER_AGENT in .env)',
  // Optional Common Alerting Protocol (CAP) feeds for official warnings outside the US.
  capFeeds: list(process.env.CAP_FEEDS),
  // Optional OpenWeather One Call 3.0 key (adds government alerts in many countries).
  openWeatherKey: process.env.OPENWEATHER_API_KEY || '',
  reportRateLimitPerHour: Number(process.env.REPORT_RATE_LIMIT_PER_HOUR || 6),
  maxPhotoBytes: Number(process.env.MAX_PHOTO_BYTES || 1_500_000),
};
