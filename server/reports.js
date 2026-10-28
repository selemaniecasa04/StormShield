// Community incident reports: storage, validation, anti-spam and moderation.
//
// Verification method (documented in docs/RISK_MODEL.md and README):
//   submitted     -> stored, visible on the map as UNVERIFIED.
//   under_review  -> automatically set once 3+ different devices confirm the same
//                    report, which puts it at the top of the moderator queue.
//                    This is corroboration, never verification.
//   verified      -> ONLY set by a moderator holding ADMIN_TOKEN.
//   resolved      -> set by a moderator, or when 3+ different devices mark it cleared.
//   rejected      -> set by a moderator; hidden from the public map.
//   expired       -> computed when a report outlives its category lifetime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const CATEGORIES = {
  flooded_road:    { label: 'Flooded road',        lifetimeH: 12 },
  strong_wind:     { label: 'Strong wind',         lifetimeH: 6 },
  fallen_tree:     { label: 'Fallen tree',         lifetimeH: 48 },
  lightning:       { label: 'Lightning strike',    lifetimeH: 3 },
  hail:            { label: 'Hail damage',         lifetimeH: 12 },
  power_outage:    { label: 'Power failure',       lifetimeH: 24 },
  building_damage: { label: 'Building damage',     lifetimeH: 72 },
  water_outage:    { label: 'Water outage',        lifetimeH: 48 },
  other:           { label: 'Other weather hazard', lifetimeH: 12 },
};
const STATUSES = ['submitted', 'under_review', 'verified', 'resolved', 'rejected'];
const CORROBORATION_THRESHOLD = 3;
const CLEARANCE_THRESHOLD = 3;
const DUPLICATE_RADIUS_M = 250;
const DUPLICATE_WINDOW_MIN = 60;

// Short list of terms that block a submission outright. Extend for your deployment.
const BLOCKED = /\b(fuck|shit|cunt|nigger|kaffir|bitch|whore)\b/i;
const LINK = /(https?:\/\/|www\.)/i;

const file = () => path.join(config.dataDir, 'reports.json');
const uploads = () => path.join(config.dataDir, 'uploads');
let reports = [];
const rate = new Map(); // key -> [timestamps]

export function loadReports() {
  fs.mkdirSync(uploads(), { recursive: true });
  try { reports = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { reports = []; }
}
function save() {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reports, null, 2));
  fs.renameSync(tmp, file());
}

export function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function effectiveStatus(r, now = Date.now()) {
  if (['rejected', 'resolved'].includes(r.status)) return r.status;
  if (now > r.expiresAt) return 'expired';
  return r.status;
}

function publicView(r, clientId) {
  const status = effectiveStatus(r);
  const own = clientId && r.clientHash === hashClient(clientId);
  return {
    id: r.id, category: r.category, categoryLabel: CATEGORIES[r.category].label,
    description: r.description, lat: r.lat, lon: r.lon,
    observedAt: r.observedAt, submittedAt: r.submittedAt, expiresAt: r.expiresAt,
    status, moderatorNote: r.moderatorNote || null, statusChangedAt: r.statusChangedAt,
    confirmations: r.confirmations.length, clearances: r.clearances.length,
    // Photos are shown publicly only after a moderator has verified the report.
    hasPhoto: Boolean(r.photo) && (status === 'verified' || own),
    own: Boolean(own),
  };
}

const hashClient = (id) => crypto.createHash('sha256').update('ss:' + String(id)).digest('hex').slice(0, 24);

function rateLimited(key) {
  const now = Date.now(), hour = 3600_000;
  const arr = (rate.get(key) || []).filter((t) => now - t < hour);
  rate.set(key, arr);
  if (arr.length >= config.reportRateLimitPerHour) return true;
  arr.push(now);
  return false;
}

export function listReports({ lat, lon, radiusKm = 25, clientId, includeInactive = false }) {
  const centre = { lat, lon };
  return reports
    .filter((r) => !Number.isFinite(lat) || haversineM(centre, r) <= radiusKm * 1000)
    .map((r) => publicView(r, clientId))
    .filter((r) => includeInactive || r.own || !['rejected', 'expired'].includes(r.status))
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

export function listMine(clientId) {
  const h = hashClient(clientId);
  return reports.filter((r) => r.clientHash === h).map((r) => publicView(r, clientId))
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

export function createReport(body, ip) {
  const errors = [];
  const category = String(body.category || '');
  const description = String(body.description || '').trim().replace(/\s+/g, ' ');
  const lat = Number(body.lat), lon = Number(body.lon);
  const clientId = String(body.clientId || '');
  const observedAt = Number(body.observedAt) || Date.now();
  const now = Date.now();

  if (!CATEGORIES[category]) errors.push('Choose an incident category.');
  if (description.length < 10) errors.push('Describe what you saw in at least 10 characters.');
  if (description.length > 500) errors.push('Keep the description under 500 characters.');
  if (BLOCKED.test(description)) errors.push('Remove offensive language from the description.');
  if (LINK.test(description)) errors.push('Links are not allowed in reports.');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) errors.push('Set a valid location for the incident.');
  if (clientId.length < 8) errors.push('Missing device identifier. Reload the page and try again.');
  if (observedAt > now + 5 * 60_000) errors.push('Observation time cannot be in the future.');
  if (observedAt < now - 48 * 3600_000) errors.push('Only report incidents observed in the last 48 hours.');
  if (errors.length) return { status: 400, body: { error: errors.join(' '), errors } };

  if (rateLimited('ip:' + ip) || rateLimited('c:' + clientId)) {
    return { status: 429, body: { error: `Report limit reached (${config.reportRateLimitPerHour} per hour). Try again later.` } };
  }

  const clientHash = hashClient(clientId);
  // Duplicate handling: a matching recent report nearby becomes a confirmation instead.
  const dup = reports.find((r) => r.category === category && !['rejected', 'resolved'].includes(r.status)
    && now < r.expiresAt && now - r.submittedAt < DUPLICATE_WINDOW_MIN * 60_000
    && haversineM(r, { lat, lon }) < DUPLICATE_RADIUS_M);
  if (dup) {
    if (dup.clientHash === clientHash) {
      return { status: 409, body: { error: 'You already reported this incident. It is shown on the map.', report: publicView(dup, clientId) } };
    }
    addConfirmation(dup, clientHash);
    save();
    return { status: 200, body: { merged: true, message: 'A matching report already exists nearby, so your submission was added as a confirmation.', report: publicView(dup, clientId) } };
  }

  const r = {
    id: crypto.randomUUID(), category, description,
    lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4,
    observedAt, submittedAt: now, expiresAt: observedAt + CATEGORIES[category].lifetimeH * 3600_000,
    status: 'submitted', statusChangedAt: now, clientHash,
    confirmations: [], clearances: [], photo: null, history: [{ at: now, status: 'submitted', by: 'submitter' }],
  };

  if (body.photo) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo));
    if (!m) return { status: 400, body: { error: 'Photo must be a JPEG, PNG or WebP image.' } };
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > config.maxPhotoBytes) return { status: 413, body: { error: `Photo is too large (max ${(config.maxPhotoBytes / 1e6).toFixed(1)} MB).` } };
    const name = `${r.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(uploads(), name), buf);
    r.photo = name;
  }
  reports.push(r);
  save();
  return { status: 201, body: { report: publicView(r, clientId) } };
}

function addConfirmation(r, clientHash) {
  if (r.clientHash === clientHash || r.confirmations.includes(clientHash)) return false;
  r.confirmations.push(clientHash);
  if (r.status === 'submitted' && r.confirmations.length >= CORROBORATION_THRESHOLD - 1) {
    // submitter + 2 others = 3 independent devices
    r.status = 'under_review'; r.statusChangedAt = Date.now();
    r.history.push({ at: Date.now(), status: 'under_review', by: 'corroboration' });
  }
  return true;
}

export function voteReport(id, kind, clientId, ip) {
  const r = reports.find((x) => x.id === id);
  if (!r) return { status: 404, body: { error: 'Report not found.' } };
  if (String(clientId || '').length < 8) return { status: 400, body: { error: 'Missing device identifier.' } };
  if (rateLimited('vote:' + ip)) return { status: 429, body: { error: 'Too many actions. Try again later.' } };
  const h = hashClient(clientId);
  const st = effectiveStatus(r);
  if (['rejected', 'resolved', 'expired'].includes(st)) return { status: 409, body: { error: `This report is ${st}.` } };
  if (kind === 'confirm') {
    if (!addConfirmation(r, h)) return { status: 409, body: { error: 'You have already confirmed this report, or you submitted it.' } };
  } else if (kind === 'clear') {
    if (r.clearances.includes(h)) return { status: 409, body: { error: 'You have already marked this as cleared.' } };
    r.clearances.push(h);
    if (r.clearances.length >= CLEARANCE_THRESHOLD) {
      r.status = 'resolved'; r.statusChangedAt = Date.now();
      r.history.push({ at: Date.now(), status: 'resolved', by: 'community-clearance' });
    }
  } else return { status: 400, body: { error: 'Unknown action.' } };
  save();
  return { status: 200, body: { report: publicView(r, clientId) } };
}

export function moderate(id, status, note) {
  const r = reports.find((x) => x.id === id);
  if (!r) return { status: 404, body: { error: 'Report not found.' } };
  if (!STATUSES.includes(status)) return { status: 400, body: { error: 'Unknown status.' } };
  r.status = status; r.statusChangedAt = Date.now(); r.moderatorNote = note ? String(note).slice(0, 300) : null;
  r.history.push({ at: Date.now(), status, by: 'moderator', note: r.moderatorNote });
  save();
  return { status: 200, body: { report: publicView(r) } };
}

export function adminList() {
  const order = { under_review: 0, submitted: 1, verified: 2, resolved: 3, expired: 4, rejected: 5 };
  return reports.map((r) => ({ ...publicView(r), hasPhoto: Boolean(r.photo), history: r.history }))
    .sort((a, b) => order[a.status] - order[b.status] || b.confirmations - a.confirmations || b.submittedAt - a.submittedAt);
}

export function photoFor(id, clientId, isAdmin) {
  const r = reports.find((x) => x.id === id);
  if (!r || !r.photo) return null;
  const allowed = isAdmin || effectiveStatus(r) === 'verified' || (clientId && r.clientHash === hashClient(clientId));
  return allowed ? path.join(uploads(), r.photo) : null;
}
