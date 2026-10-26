// StormShield application controller: location, data loading, risk, rendering.
import { state, setState, setSource, setPref, subscribe } from './state.js';
import { icon } from './ui/icons.js';
import { views, miniRisk } from './ui/views.js';
import { HazardMap } from './map.js';
import * as om from './providers/openmeteo.js';
import { searchPlaces, reverseName, emergencyResources, terrainContext } from './providers/osm.js';
import { radarFrame, server } from './providers/external.js';
import { assess, explainChange, levelRank } from './risk.js';
import { buildDemo, SCENARIOS } from './demo.js';
import { analyseJourney } from './journey.js';
import { esc, haversineM, setUnits, store, fmtDist, timeAgo } from './util.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = ['overview', 'map', 'journey', 'resources', 'reports', 'alerts', 'settings'];
const DEMO_FALLBACK = { lat: -29.8587, lon: 31.0218, label: 'Durban (demonstration area)' };

let hmap; let watchId = null; let lastLoadAt = null; let lastLoadLoc = null; let pickCb = null;
const raw = { weather: null, air: null, river: null, terrain: null, grid: null, gridMeta: null, airGrid: null, warnings: [], warningsCoverage: null };
const mounted = {};

// ------------------------------------------------------------------ Theme & units
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme; else root.dataset.theme = pref;
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeBtn').innerHTML = icon(dark ? 'sun' : 'moon');
  $('themeBtn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#121c23' : '#ffffff';
  hmap?.setTheme(dark);
  refreshMapData();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.prefs.theme === 'system') applyTheme('system'); });

// ------------------------------------------------------------------ Toast
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3800); }

// ------------------------------------------------------------------ Location
function setLocation(loc, mode) {
  const prev = state.location;
  setState({ location: loc, locationMode: mode, locationStatus: mode === 'manual' ? state.locationStatus : 'ok' });
  $('onboard').hidden = true;
  hmap.setUser(loc, mode, { recentre: !prev || mode === 'manual' || (prev && haversineM(prev, loc) > 20000) });
  const moved = !lastLoadLoc || haversineM(lastLoadLoc, loc) > 1500;
  if (moved) loadAll();
  else recompute(); // movement speed/heading can change exposure
}

function geoError(err) {
  const status = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
  setState({ locationStatus: status });
  const msg = { denied: 'Location permission was denied. You can search for a place instead, or allow location in your browser settings and try again.', timeout: 'Getting your location took too long. Try again or search for a place.', unavailable: 'Your device could not determine your location. Search for a place instead.' }[status];
  if (!state.location) { $('onboard').hidden = false; $('obStatus').innerHTML = `<div class="notice warn">${icon('warning')}<div>${msg}</div></div>`; }
  else toast(msg);
}

function locate() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { setState({ locationStatus: 'unsupported' }); $('onboard').hidden = false; $('obStatus').innerHTML = `<div class="notice warn">${icon('warning')}<div>This browser does not support location. Search for a place instead.</div></div>`; return resolve(false); }
    setState({ locationStatus: 'requesting' });
    $('obStatus').innerHTML = `<p class="small muted">Waiting for location permission…</p>`;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    let first = true;
    const ok = (p) => {
      const c = p.coords;
      setLocation({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? c.speed : null, at: p.timestamp }, state.prefs.follow ? 'following' : 'fixed');
      if (first) { first = false; resolve(true); }
    };
    const bad = (e) => { geoError(e); if (first) { first = false; resolve(false); } };
    const opts = { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 };
    if (state.prefs.follow) watchId = navigator.geolocation.watchPosition(ok, bad, opts);
    else navigator.geolocation.getCurrentPosition(ok, bad, opts);
  });
}
function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (state.location && state.locationMode === 'following') setState({ locationMode: 'fixed' });
  toast('Location tracking stopped. StormShield keeps your last position.');
}
function setManual(p) {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  setState({ placeName: p.label || null });
  setLocation({ lat: p.lat, lon: p.lon, accuracy: null, heading: null, speed: null, at: Date.now() }, 'manual');
  toast(`Monitoring ${p.label ? p.label.split(',')[0] : 'the chosen point'}.`);
}

// ------------------------------------------------------------------ Data loading
async function track(name, fn, { onOk } = {}) {
  setSource(name, { status: 'loading', error: null });
  try {
    const v = await fn();
    if (v && v.status === 'not_applicable') { setSource(name, { status: 'not_applicable', note: v.note, updatedAt: Date.now() }); return null; }
    setSource(name, { status: 'ok', updatedAt: v?.updatedAt || Date.now(), demo: false, note: v?.note || null });
    onOk?.(v); return v;
  } catch (e) {
    console.warn(name, e);
    setSource(name, { status: 'error', error: e.message || String(e), updatedAt: Date.now() });
    return null;
  }
}

async function loadAll(force = false) {
  const loc = state.location; if (!loc) return;
  lastLoadAt = Date.now(); lastLoadLoc = { lat: loc.lat, lon: loc.lon };
  if (state.demo.active) return applyDemo();

  const { lat, lon } = loc;
  // Place name (for display and emergency numbers)
  if (state.locationMode !== 'manual' || !state.placeName) track('place', async () => { const r = await reverseName(lat, lon); setState({ placeName: state.locationMode === 'manual' && state.placeName ? state.placeName : r.name, countryCode: r.cc }); return r; });
  else track('place', async () => { const r = await reverseName(lat, lon); setState({ countryCode: r.cc }); return r; });

  const g = om.gridPoints(lat, lon);
  raw.gridMeta = g;
  const jobs = [
    track('weather', () => om.forecast(lat, lon), { onOk: (v) => { raw.weather = v; } }),
    track('air', () => om.airQuality(lat, lon), { onOk: (v) => { raw.air = v; } }),
    track('river', () => om.riverDischarge(lat, lon), { onOk: (v) => { raw.river = v; } }),
    track('grid', async () => { const v = await om.forecastGrid(g.pts); return { list: v, updatedAt: v[0]?.time }; }, { onOk: (v) => { raw.grid = v.list; hmap.setGrid(raw.grid, raw.gridMeta); hmap.setFords(raw.terrain?.fords); } }),
    track('airgrid', async () => { const v = await om.airQualityGrid(g.pts); return { list: v }; }, { onOk: (v) => { raw.airGrid = v.list; hmap.setAirGrid(raw.airGrid, raw.gridMeta); } }),
    track('terrain', () => terrainContext(lat, lon), { onOk: (v) => { raw.terrain = v; hmap.setFords(v.fords); } }),
    track('warnings', async () => {
      const v = await server.warnings(lat, lon);
      return { ...v, note: v.coverage === 'none' ? 'No feed covers this location' : `${v.sources.filter((s) => s.status === 'ok').map((s) => s.name).join(', ')}`, sourcesOk: v.sources.filter((s) => s.status === 'ok').map((s) => s.name) };
    }, { onOk: (v) => { raw.warnings = v.warnings; raw.warningsCoverage = v.coverage; setSource('warnings', { sourcesOk: v.sourcesOk }); hmap.setWarnings(v.warnings); } }),
    loadReports(),
    track('radar', () => radarFrame().then((f) => ({ ...f, updatedAt: f.time })), { onOk: (f) => { hmap.setRadar(f); hmap.setVisible(state.prefs.layers); } }),
  ];
  if (state.prefs.layers.resources || state.section === 'resources' || force) jobs.push(loadResources(force));
  // Recompute as each source lands so the user sees progress, then once all settle.
  jobs.forEach((j) => j.then(() => recompute()));
  await Promise.allSettled(jobs);
  if (!raw.weather && state.sources.weather?.status === 'error') recompute();
}

async function loadReports() {
  if (!state.location) return;
  if (state.demo.active) return;
  return track('reports', async () => {
    const { reports } = await server.reports(state.location.lat, state.location.lon, 30);
    const withD = reports.map((r) => ({ ...r, distance: haversineM(state.location, r) }));
    setState({ reports: withD });
    hmap.setReports(withD, (r) => openReport(r));
    return { updatedAt: Date.now() };
  });
}
async function loadMine() {
  try { const { reports } = await server.mine(); setState({ myReports: reports }); } catch { setState({ myReports: [] }); }
}

let resourcesFor = null;
async function loadResources(force) {
  const loc = state.location; if (!loc) return;
  if (!force && resourcesFor && haversineM(resourcesFor, loc) < 3000 && state.resources?.status === 'ok') return;
  resourcesFor = { lat: loc.lat, lon: loc.lon };
  setState({ resources: { status: 'loading' } });
  const v = await track('resources', async () => { const items = await emergencyResources(loc.lat, loc.lon); return { items, updatedAt: Date.now() }; });
  if (v) { setState({ resources: { status: 'ok', items: v.items } }); hmap.setResources(v.items); }
  else setState({ resources: { status: 'error', error: state.sources.resources?.error } });
}

function refreshMapData() {
  if (!hmap) return;
  const demo = state.demo.active;
  if (raw.grid) hmap.setGrid(raw.grid, raw.gridMeta, { demo });
  if (raw.terrain) hmap.setFords(raw.terrain.fords, { demo });
  if (raw.airGrid) hmap.setAirGrid(raw.airGrid, raw.gridMeta, { demo });
  hmap.setWarnings(raw.warnings);
  hmap.setReports(state.reports, openReport);
  if (state.resources?.items) hmap.setResources(state.resources.items);
  if (state.journey?.routes) hmap.setJourney(state.journey, state.journey.selectedId);
  hmap.setVisible(state.prefs.layers);
}

// ------------------------------------------------------------------ Demo mode
function startDemo(key) {
  const loc = state.location || { ...DEMO_FALLBACK, accuracy: null };
  setState({ demo: { active: true, scenario: key }, assessment: null, history: [] });
  if (!state.location) { setState({ placeName: DEMO_FALLBACK.label }); setLocation({ lat: loc.lat, lon: loc.lon, accuracy: null, at: Date.now() }, 'manual'); }
  else applyDemo();
  toast(`Demonstration scenario loaded: ${SCENARIOS[key].label}.`);
}
function applyDemo() {
  const loc = state.location; const d = buildDemo(state.demo.scenario, loc);
  Object.assign(raw, { weather: d.weather, air: d.air, river: d.river, terrain: d.terrain, grid: d.grid, gridMeta: { step: 0.12, stepLon: 0.14 }, airGrid: d.grid, warnings: d.warnings, warningsCoverage: 'connected' });
  for (const k of ['weather', 'air', 'river', 'grid', 'airgrid', 'terrain', 'warnings', 'reports']) setSource(k, { status: 'ok', demo: true, updatedAt: Date.now(), error: null, note: 'Demonstration data' });
  const reports = d.reports.map((r) => ({ ...r, distance: haversineM(loc, r) }));
  setState({ reports });
  refreshMapData();
  recompute();
}
function stopDemo() {
  setState({ demo: { active: false, scenario: null }, reports: [], history: [] });
  Object.assign(raw, { weather: null, air: null, river: null, terrain: null, grid: null, airGrid: null, warnings: [], warningsCoverage: null });
  setState({ assessment: null });
  hmap.setGrid([], {}); hmap.setAirGrid([], {}); hmap.setWarnings([]); hmap.setReports([]);
  if (state.locationMode === 'manual' && state.placeName === DEMO_FALLBACK.label) { setState({ location: null, locationMode: 'none', placeName: null }); hmap.setUser(null); $('onboard').hidden = false; }
  else loadAll(true);
  toast('Demonstration mode off. Showing live data.');
}

// ------------------------------------------------------------------ Risk
function recompute() {
  if (!state.location) return;
  const conditions = {
    weather: raw.weather, air: raw.air, river: raw.river, terrain: raw.terrain, grid: raw.grid,
    warnings: raw.warnings, warningsCoverage: state.demo.active ? 'connected' : raw.warningsCoverage || (state.sources.warnings?.status === 'error' ? 'none' : raw.warningsCoverage),
    reports: state.reports, location: state.location, demo: state.demo.active, now: Date.now(),
  };
  // Hold the assessment until weather has either loaded or failed, so the score does not flash.
  if (!raw.weather && state.sources.weather?.status !== 'error') { setState({ conditions }); return; }
  const next = assess(conditions, { activityPref: state.prefs.activity });
  const prev = state.assessment;
  let history = state.history;
  if (!prev || prev.score !== next.score || prev.level !== next.level) {
    const reasons = explainChange(prev, next);
    if (prev && next.score != null) history = [{ at: Date.now(), from: prev.score, to: next.score, level: next.level, reasons: reasons.length ? reasons : ['Updated data.'] }, ...history].slice(0, 50);
    else if (!prev && next.score != null) history = [{ at: Date.now(), from: null, to: next.score, level: next.level, reasons: ['First assessment for this location.'] }, ...history].slice(0, 50);
    if (prev && levelRank[next.level] > levelRank[prev.level]) notify(next);
  }
  setState({ conditions, assessment: next, previousAssessment: prev, history });
}

function notify(a) {
  const text = `Risk rose to ${a.level}: ${a.hazards[0]?.label || ''}`;
  setState({ alertsLog: [{ at: Date.now(), text }, ...state.alertsLog].slice(0, 50) });
  if (state.prefs.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted' && levelRank[a.level] >= levelRank[state.prefs.notifyMin]) {
    try { new Notification(`StormShield: ${a.level}`, { body: `${a.hazards[0]?.label || 'Conditions changed'}. Open StormShield for what to do.`, tag: 'stormshield-level' }); } catch { /* some browsers need a service worker */ }
  }
}

// ------------------------------------------------------------------ Journey
let lastDest = null;
async function runJourney(dest) {
  if (dest) lastDest = dest; dest = lastDest;
  if (!dest) return;
  if (!state.location) { toast('Set your starting location first.'); return; }
  setState({ journey: { status: 'loading' } });
  try {
    const j = await analyseJourney({ from: state.location, to: dest, toLabel: dest.name, demo: state.demo.active ? buildDemo(state.demo.scenario, state.location) : null, reports: state.reports });
    j.selectedId = j.recommendedId;
    setState({ journey: j });
    hmap.setJourney(j, j.selectedId);
    if (matchMedia('(max-width: 760px)').matches) document.querySelector('.mapwrap').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setState({ journey: { status: 'error', error: e.message } });
  }
}
function selectRoute(id) { const j = { ...state.journey, selectedId: id }; setState({ journey: j }); hmap.setJourney(j, id); }

// ------------------------------------------------------------------ Reports
async function submitReport(body) {
  if (state.demo.active) throw new Error('Reports cannot be submitted while demonstration mode is on. Turn it off in Settings first.');
  const res = await server.submit(body);
  await Promise.all([loadReports(), loadMine()]);
  recompute();
  return res;
}
async function vote(id, kind) { await server.vote(id, kind); await loadReports(); recompute(); }
function openReport(r) {
  go('reports');
  setTimeout(() => toast(`${r.categoryLabel}: ${r.status === 'verified' ? 'verified' : 'unverified'} report, ${timeAgo(r.observedAt)}`), 50);
}

// ------------------------------------------------------------------ Navigation & rendering
function go(section, { focus = false } = {}) {
  if (!SECTIONS.includes(section)) section = 'overview';
  setState({ section });
  try { if (location.hash !== '#' + section) history.replaceState(null, '', '#' + section); } catch { /* sandboxed */ }
  const view = $('view');
  view.innerHTML = '';
  views[section].mount(view, ctx);
  mounted.current = section;
  views[section].update(state);
  view.scrollTop = 0;
  document.getElementById('app').classList.toggle('map-focus', section === 'map');
  hmap?.invalidate();
  if (focus) view.focus();
  renderChrome();
}

function navHtml(short) {
  const badge = (k) => {
    if (k === 'alerts') { const n = (state.conditions?.warnings?.length || 0) + (state.assessment?.hazards.filter((h) => !h.official && h.severity >= 0.6).length || 0); return n ? `<span class="badge">${n}</span>` : ''; }
    return '';
  };
  return SECTIONS.map((k) => `<button class="nav-btn" type="button" data-go="${k}" ${state.section === k ? 'aria-current="page"' : ''} aria-label="${views[k].title}">${icon(views[k].icon)}<span>${short ? views[k].short : k === 'journey' ? 'Journey' : views[k].title.split(' ').slice(-1)[0]}</span>${badge(k)}</button>`).join('');
}

function renderChrome() {
  $('nav').innerHTML = navHtml(false);
  $('tabbar').innerHTML = navHtml(true);
  // Location bar
  const s = state; const l = s.location;
  const modeLabel = { following: 'Following', fixed: 'Fixed', manual: 'Chosen area', none: 'No location' }[s.locationMode];
  $('locBar').innerHTML = `<span class="loc-mode ${s.locationMode}" title="${s.locationMode === 'following' ? 'Updating as you move' : s.locationMode === 'fixed' ? 'Single GPS reading' : s.locationMode === 'manual' ? 'Monitoring a point you chose' : ''}">${modeLabel}</span><span class="loc-name">${l ? esc(s.placeName || `${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}`) : s.locationStatus === 'requesting' ? 'Locating…' : 'Set a location'}</span>${l?.accuracy && s.locationMode !== 'manual' ? `<span class="small muted num">±${fmtDist(l.accuracy)}</span>` : ''}`;
  // Banners
  const b = [];
  if (s.demo.active) b.push(`<div class="banner demo">${icon('demo')}<span>DEMONSTRATION DATA: ${esc(SCENARIOS[s.demo.scenario].label)}. Nothing shown is a real observation or warning.</span><button class="btn" type="button" data-act="stopDemo">Turn off</button></div>`);
  if (s.assessment?.level === 'EMERGENCY') b.push(`<div class="banner emergency">${icon('warning')}<span>Take protective action now. Follow local authorities.</span></div>`);
  if (s.location?.speed > 7 && s.locationMode === 'following') b.push(`<div class="banner driving">${icon('car')}<span>You seem to be travelling fast. If you are driving, do not use this app. Pull over safely first.</span></div>`);
  if (s.sources.weather?.status === 'error' && !s.demo.active) b.push(`<div class="banner err">${icon('warning')}<span>Weather data is unavailable, so your risk cannot be assessed.</span><button class="btn" type="button" data-act="refresh">Retry</button></div>`);
  $('banners').innerHTML = b.join('');
  // Map overlay
  $('mapStatus').innerHTML = miniRisk(s) + (s.demo.active ? '<span class="chip demo" style="align-self:flex-start">Demo data</span>' : '');
  hmap?.setVisible(s.prefs.layers);
}

let renderQueued = false;
function render() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderChrome();
    const v = views[mounted.current];
    if (v) { try { v.update(state); } catch (e) { console.error(e); } }
  });
}

// ------------------------------------------------------------------ Context passed to views
const ctx = {
  state,
  refresh: (force) => { if (!state.location) { toast('Set a location first.'); return; } loadAll(force); toast('Refreshing data…'); },
  locate, stopTracking, setManual, search: searchPlaces,
  setLayer: (k, v) => { setPref('layers', { ...state.prefs.layers, [k]: v }); if (k === 'resources' && v) loadResources(false); },
  setPref: (k, v) => { setPref(k, v); if (k === 'activity') recompute(); },
  setTheme: (v) => { setPref('theme', v); applyTheme(v); },
  setUnits: (v) => { setPref('units', v); setUnits(v); refreshMapData(); render(); },
  setFollow: (v) => { setPref('follow', v); if (state.locationMode !== 'manual') locate(); },
  enableNotifications: async (on) => {
    if (!on) { setPref('notify', false); return false; }
    if (typeof Notification === 'undefined') { toast('Notifications are not supported in this browser.'); return false; }
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') { toast('Notifications are blocked. Allow them in your browser settings.'); setPref('notify', false); return false; }
    setPref('notify', true); toast('Notifications on. You will be alerted when your risk level rises.'); return true;
  },
  clearLocal: () => { store.clear(); },
  pickOnMap: (hint, cb) => {
    pickCb = cb; $('mapHint').textContent = hint; $('mapHint').hidden = false;
    if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  flyTo: (lat, lon) => { hmap.map.setView([lat, lon], 15); if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' }); },
  analyseJourney: runJourney, selectRoute, submitReport, vote, loadReports: async () => { await loadReports(); recompute(); }, loadMine, loadResources,
  startDemo, stopDemo, toast,
  admin: server.admin,
};

// ------------------------------------------------------------------ Boot
function boot() {
  setUnits(state.prefs.units);
  hmap = new HazardMap($('map'), {
    onMapClick: (ll) => { if (!pickCb) return; const cb = pickCb; pickCb = null; $('mapHint').hidden = true; hmap.setPick(ll); setTimeout(() => hmap.setPick(null), 4000); cb(ll); },
  });
  applyTheme(state.prefs.theme);
  $('refreshBtn').innerHTML = icon('refresh');
  $('recentreBtn').innerHTML = icon('locate');
  $('layersBtn').innerHTML = icon('layers');

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go, { focus: true }); return; }
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'stopDemo') stopDemo();
    if (a?.dataset.act === 'refresh' && a.closest('#banners')) ctx.refresh(true);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pickCb) { pickCb = null; $('mapHint').hidden = true; } });
  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    ctx.setTheme(dark ? 'light' : 'dark');
  });
  $('refreshBtn').addEventListener('click', () => ctx.refresh(true));
  $('recentreBtn').addEventListener('click', () => { if (state.location) hmap.recentre(state.location); else locate(); });
  $('layersBtn').addEventListener('click', () => go('map'));

  // Onboarding
  $('obLocate').addEventListener('click', () => locate());
  $('obDemo').addEventListener('click', () => startDemo('thunderstorm'));
  $('obSearch').addEventListener('submit', async (e) => {
    e.preventDefault(); const q = $('obQuery').value.trim(); if (!q) return;
    const out = $('obResults'); out.innerHTML = '<li class="empty">Searching…</li>';
    try {
      const list = await searchPlaces(q);
      out.innerHTML = list.length ? list.map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)}</button></li>`).join('') : '<li class="empty">No places found. Try a nearby town.</li>';
      out.onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; out.innerHTML = ''; setManual({ ...list[+b.dataset.i], label: list[+b.dataset.i].name }); };
    } catch (err) { out.innerHTML = `<li class="notice err">${icon('warning')} Place search is unavailable: ${esc(err.message)}. Try the demonstration instead.</li>`; }
  });

  subscribe(render);
  const initial = (location.hash || '').slice(1);
  go(SECTIONS.includes(initial) ? initial : 'overview');
  $('onboard').hidden = false;

  // Request location straight away, as the brief asks; the card explains why and offers fallbacks.
  locate();

  // Refresh cadence matched to each source's update frequency
  setInterval(() => { if (state.location && Date.now() - (lastLoadAt || 0) > 10 * 60_000 - 1000) loadAll(); }, 60_000);
  setInterval(() => { if (state.location && !state.demo.active) loadReports().then(recompute); }, 2 * 60_000);
  setInterval(() => { if (state.location && !state.demo.active) track('radar', () => radarFrame().then((f) => ({ ...f, updatedAt: f.time })), { onOk: (f) => { hmap.setRadar(f); hmap.setVisible(state.prefs.layers); } }); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.location && Date.now() - (lastLoadAt || 0) > 5 * 60_000) loadAll(); });
  window.addEventListener('online', () => { toast('Back online. Refreshing.'); if (state.location) loadAll(); });
  window.addEventListener('offline', () => toast('You are offline. Data shown may be out of date.'));
}

boot();
