// Section views. Each view mounts its static structure once, then update(state)
// refreshes only the dynamic regions, so forms keep what the person typed.
import { icon } from './icons.js';
import { esc, timeAgo, clock, dateTime, fmtTemp, fmtSpeed, fmtPrecip, fmtDist, compass, WMO, isThunder, getUnits } from '../util.js';
import { adviceFor, headline, LEVEL_TEXT } from '../advice.js';
import { LAYERS, aqiLabel } from '../map.js';
import { Simulator, sceneFor } from '../simulator.js';
import { RESOURCE_TYPES } from '../providers/osm.js';
import { SCENARIOS } from '../demo.js';
import { RISK_CONFIG } from '../risk.js';

const sevCss = (s) => (s >= 0.85 ? 'emergency' : s >= 0.6 ? 'warning' : s >= 0.3 ? 'watch' : 'safe');
const lvlCss = { SAFE: 'safe', WATCH: 'watch', WARNING: 'warning', EMERGENCY: 'emergency', UNKNOWN: 'unknown' };
const LEVEL_ICON = { SAFE: 'safe', WATCH: 'info', WARNING: 'warning', EMERGENCY: 'warning', UNKNOWN: 'info', LOADING: 'clock' };
const HAZ_ICON = { storm: 'lightning', hail: 'hail', flood: 'flood', wind: 'wind', heat: 'heat', cold: 'cold', uv: 'uv', air: 'air', visibility: 'visibility' };
const basisChip = (b) => ({ 'forecast-model': '<span class="chip model">Model</span>', official: '<span class="chip official">Official</span>', community: '<span class="chip community">Community</span>', demo: '<span class="chip demo">Demo</span>', observation: '<span class="chip model">Observed</span>' }[b] || '');
const hIcon = (h) => (h.official ? 'official' : HAZ_ICON[h.id] || 'warning');

export const SOURCE_LABELS = {
  weather: 'Weather forecast (Open-Meteo)', air: 'Air quality (CAMS)', river: 'River flow (GloFAS)', grid: 'Area forecast grid',
  radar: 'Rain radar (RainViewer)', warnings: 'Official warnings', reports: 'Community reports', terrain: 'Waterways & fords (OpenStreetMap)',
  resources: 'Emergency facilities (OpenStreetMap)', place: 'Place name (OpenStreetMap)', airgrid: 'Area air-quality grid',
};

export function gaugeSvg(score) {
  const r = 46, c = 2 * Math.PI * r; const pct = score == null ? 0 : score / 100;
  return `<svg viewBox="0 0 112 112" aria-hidden="true"><circle class="track" cx="56" cy="56" r="${r}" fill="none" stroke-width="10"/><circle class="val" cx="56" cy="56" r="${r}" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg>`;
}

export function riskCard(s) {
  const a = s.assessment;
  if (!a) {
    const msg = s.locationMode === 'none' ? 'Share your location or search for a place to see your risk.' : 'Checking weather, warnings and hazards around you…';
    return `<div class="risk LOADING"><div class="gauge">${gaugeSvg(null)}<div class="gauge-num"><div><b>–</b><span>score</span></div></div></div><div><div class="risk-level">${icon('clock')} ${s.locationMode === 'none' ? 'NO LOCATION' : 'CHECKING'}</div><p class="risk-head">${msg}</p></div></div>`;
  }
  const lvl = a.level;
  const conf = a.confidence === 'demo' ? '<span class="chip demo">Demo data</span>' : `<span class="chip neutral">${a.confidence} confidence</span>`;
  return `<div class="risk ${lvl}" role="group" aria-label="Preparedness score">
    <div class="gauge">${gaugeSvg(a.score)}<div class="gauge-num"><div><b class="num">${a.score ?? '–'}</b><span>of 100</span></div></div></div>
    <div>
      <div class="risk-level">${icon(LEVEL_ICON[lvl])} ${lvl}</div>
      <p class="risk-head">${esc(headline(a))}</p>
      <p class="risk-meta">${esc(LEVEL_TEXT[lvl])}</p>
      <div class="row" style="margin-top:8px">${conf}<span class="small muted">Updated ${clock(a.computedAt)}</span></div>
    </div>
  </div>`;
}

export function miniRisk(s) {
  const a = s.assessment;
  const lvl = a?.level || 'LOADING';
  return `<button class="mini-risk ${lvl}" type="button" data-go="overview" aria-label="Preparedness ${a?.score ?? 'unknown'}, ${lvl}. Open overview."><b class="num">${a?.score ?? '–'}</b><span><span class="lv">${a ? lvl : s.locationMode === 'none' ? 'NO LOCATION' : 'CHECKING'}</span><br><span class="sub">${a ? (a.level === 'UNKNOWN' ? 'Weather data unavailable' : esc(a.hazards[0]?.label || 'No significant threat found')) : 'Preparedness score'}</span></span></button>`;
}

function actionCard(h, activity, open = true) {
  const adv = adviceFor(h, activity);
  const when = h.when === 'now' ? 'Now' : typeof h.when === 'number' ? `From about ${clock(h.when)}` : 'Within 6 hours';
  return `<article class="action lv-${h.level}">
    <div class="action-h">${icon(hIcon(h))}<div style="min-width:0"><h3>${esc(h.label)}</h3><div class="row small" style="margin-top:4px"><span class="chip ${sevCss(h.severity)}">${h.level}</span>${basisChip(h.basis)}<span class="muted">${when}</span></div></div></div>
    ${open ? `<div class="action-b"><dl><dt>What</dt><dd>${esc(adv.what)}</dd><dt>Why</dt><dd>${esc(adv.why)}</dd></dl>
      <div><div class="eyebrow" style="margin-bottom:6px">What to do</div><ol>${adv.do.map((d) => `<li>${esc(d)}</li>`).join('')}</ol></div>
      <div class="src">Source: ${esc(h.source)}${h.value ? ` · ${esc(h.value)}` : ''}</div></div>` : ''}
  </article>`;
}

function officialCard(o) {
  const c = o.severity === 'Extreme' ? 'emergency' : o.severity === 'Severe' ? 'warning' : o.severity === 'Moderate' ? 'watch' : 'neutral';
  return `<article class="action ${c === 'emergency' ? 'lv-severe' : c === 'warning' ? 'lv-high' : 'lv-moderate'}">
    <div class="action-h">${icon('official')}<div style="min-width:0"><h3>${esc(o.event || 'Official warning')}</h3>
      <div class="row small" style="margin-top:4px">${o.demo ? '<span class="chip demo">Demo</span>' : '<span class="chip official">Official</span>'}<span class="chip ${c}">Severity: ${esc(o.severity)}</span>${o.urgency ? `<span class="muted">${esc(o.urgency)} · ${esc(o.certainty || '')}</span>` : ''}</div></div></div>
    <div class="action-b">
      ${o.headline ? `<p><b>${esc(o.headline)}</b></p>` : ''}
      ${o.description ? `<div class="official-text">${esc(o.description)}</div>` : ''}
      ${o.instruction ? `<div><div class="eyebrow" style="margin-bottom:4px">Instructions from the issuer</div><div class="official-text">${esc(o.instruction)}</div></div>` : ''}
      <div class="src">Issued by ${esc(o.sourceName)}${o.areaDesc ? ` · Area: ${esc(o.areaDesc)}` : ''}${o.onset ? ` · From ${dateTime(Date.parse(o.onset))}` : ''}${o.expires ? ` · Until ${dateTime(Date.parse(o.expires))}` : ''}${o.geoMatched ? '' : ' · Regional: not matched to your exact location'}${o.url ? ` · <a href="${esc(o.url)}" target="_blank" rel="noopener">Original</a>` : ''}</div>
    </div></article>`;
}

function sourcesList(s) {
  const rows = Object.entries(s.sources).map(([k, v]) => {
    const st = s.demo.active && v.demo ? 'demo' : v.status;
    const label = { ok: 'Live', error: 'Unavailable', unavailable: 'Unavailable', loading: 'Loading', not_applicable: 'Not covered', not_configured: 'Not set up', demo: 'Demo', off: 'Off' }[st] || st;
    const kind = { weather: 'model forecast', air: 'model forecast', river: 'model forecast', grid: 'model forecast', radar: 'radar observation', warnings: 'official', reports: 'community', terrain: 'mapped', resources: 'mapped', place: 'mapped' }[k];
    const detail = v.error ? esc(v.error) : v.note ? esc(v.note) : v.updatedAt ? `Updated ${timeAgo(v.updatedAt)}${kind ? ` · ${kind}` : ''}` : '';
    return `<div class="source"><span>${esc(SOURCE_LABELS[k] || k)}</span><span class="st ${st}">${label}</span>${detail ? `<span class="d">${detail}</span>` : ''}</div>`;
  });
  return rows.length ? `<div class="sources">${rows.join('')}</div>` : '<p class="empty">No data requested yet.</p>';
}

// ===================================================================
export const views = {
  // ---------------------------------------------------------------- Overview
  overview: {
    title: 'Overview', short: 'Now', icon: 'overview',
    mount(el, ctx) {
      el.innerHTML = `
        <div id="ovRisk"></div>
        <div id="ovFactors"></div>
        <section class="stack" aria-labelledby="simH"><div class="section-h"><h3 id="simH">Conditions around you</h3><span class="small muted">Illustration of the data, not a camera</span></div>
          <div class="sim"><canvas id="simCanvas" aria-hidden="true"></canvas><span class="sim-tag" id="simTag"></span><div class="sim-read" id="simRead"></div><div class="sim-none" id="simNone" hidden></div></div></section>
        <section class="stack" aria-labelledby="actH"><h3 id="actH">What to do now</h3><div class="stack" id="ovActions"></div></section>
        <section class="stack" aria-labelledby="condH"><div class="section-h"><h3 id="condH">Current conditions</h3><span class="small muted" id="condTime"></span></div><div id="ovConds"></div></section>
        <section class="stack" aria-labelledby="hrsH"><div class="section-h"><h3 id="hrsH">Next 12 hours</h3><span class="small muted">Rain chance · gusts</span></div><div id="ovHours"></div></section>
        <section class="card flat" aria-labelledby="limH"><h3 id="limH">Coverage and limits</h3><div id="ovGaps" class="small"></div></section>
        <section class="card" aria-labelledby="srcH"><div class="section-h"><h3 id="srcH">Data sources</h3><button class="btn sm" type="button" data-act="refresh">${icon('refresh')} Refresh</button></div><div id="ovSources"></div></section>`;
      this.sim = new Simulator(el.querySelector('#simCanvas'));
      el.addEventListener('click', (e) => { if (e.target.closest('[data-act="refresh"]')) ctx.refresh(true); });
    },
    update(s) {
      const $ = (id) => document.getElementById(id);
      $('ovRisk').innerHTML = riskCard(s);
      const a = s.assessment; const w = s.conditions?.weather;
      // Contributing factors
      if (a && a.hazards.length) {
        const last = s.history[0];
        $('ovFactors').innerHTML = `<div class="card"><div class="section-h"><h3>Why this score</h3><span class="small muted">Worst hazard dominates</span></div><div class="factors">${a.hazards.slice(0, 6).map((h) => `<div class="factor">${icon(hIcon(h))}<span>${esc(h.label)} ${basisChip(h.basis)}</span><span class="chip ${sevCss(h.severity)}">${h.level}</span><span class="bar"><i style="width:${Math.round(h.severity * 100)}%;background:var(--${sevCss(h.severity)})"></i></span></div>`).join('')}</div>
          ${a.activity !== 'unknown' ? `<p class="small muted">Adjusted for ${a.activityInferred ? 'detected' : 'chosen'} activity: <b>${a.activity}</b>.</p>` : ''}
          ${last?.reasons?.length ? `<div class="notice">${icon('info')}<div><b>Changed ${timeAgo(last.at)}</b> (${last.from ?? '–'} → ${last.to}): ${esc(last.reasons.join(' '))}</div></div>` : ''}</div>`;
      } else if (a && a.level !== 'UNKNOWN') {
        $('ovFactors').innerHTML = '<div class="notice">' + icon('safe') + '<div>No hazard crossed StormShield\'s thresholds in the available data. Keep checking official forecasts, especially before travel.</div></div>';
      } else $('ovFactors').innerHTML = a?.level === 'UNKNOWN' ? `<div class="notice err">${icon('warning')}<div>${esc(a.gaps[0])}</div></div>` : '';

      // Simulator
      const scene = sceneFor(a);
      const params = { rain: w?.current.precip, gust: w?.current.gust, windDir: w?.current.windDir, aqi: s.conditions?.air?.usAqi, apparent: w?.current.apparent, uv: w?.current.uv, river: s.conditions?.river?.ratio, isDay: w?.current.isDay ?? true };
      this.sim.set(scene, params);
      $('simTag').textContent = scene === 'none' ? 'No data' : s.demo.active ? 'Demo scenario' : `Scene: ${a?.hazards.find((h) => sceneFor({ level: 'X', hazards: [h] }) === scene)?.label || (scene === 'calm' ? 'Calm' : scene)}`;
      $('simNone').hidden = scene !== 'none';
      $('simNone').textContent = s.locationMode === 'none' ? 'Set a location to see conditions.' : a?.level === 'UNKNOWN' ? 'Weather data unavailable. The scene is not shown rather than guessed.' : 'Loading conditions…';
      $('simRead').innerHTML = w ? [
        `${fmtTemp(w.current.temp)} · feels ${fmtTemp(w.current.apparent)}`, `${fmtPrecip(w.current.precip)}/h`, `gust ${fmtSpeed(w.current.gust)} ${compass(w.current.windDir)}`,
        s.conditions?.air ? `AQI ${s.conditions.air.usAqi}` : null, w.current.uv != null && w.current.isDay ? `UV ${Math.round(w.current.uv)}` : null,
      ].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('') : '';

      // Actions
      if (!a) $('ovActions').innerHTML = '<div class="skeleton" style="height:90px"></div>';
      else if (a.level === 'UNKNOWN') $('ovActions').innerHTML = `<div class="notice">${icon('info')}<div>Without weather data StormShield cannot give tailored advice. Follow your national weather service and local authorities.</div></div>`;
      else {
        const top = a.hazards.filter((h) => h.severity >= 0.15).slice(0, 3);
        const urgent = a.level === 'EMERGENCY' ? `<div class="notice err">${icon('phone')}<div><b>If life is in danger, call your local emergency number now.</b> Follow instructions from local authorities. <button class="btn sm" type="button" data-go="resources">Emergency numbers</button></div></div>` : '';
        $('ovActions').innerHTML = urgent + (top.length ? top.map((h, i) => actionCard(h, a.activity, i < 2 || a.level === 'EMERGENCY')).join('') : `<div class="notice">${icon('safe')}<div>No protective action needed right now. Check again before you travel or spend long periods outdoors.</div></div>`);
      }

      // Conditions
      if (w) {
        const c = w.current; const air = s.conditions.air; const river = s.conditions.river; const terr = s.conditions.terrain;
        const cell = (k, v, sub) => `<div class="cond"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
        $('ovConds').innerHTML = `<div class="conds">
          ${cell('Temperature', fmtTemp(c.temp), `Feels ${fmtTemp(c.apparent)}`)}
          ${cell('Sky', esc(WMO[c.code] || '—'), `Cloud ${c.cloud ?? '—'}%`)}
          ${cell('Rain now', fmtPrecip(c.precip), `${c.precipProb ?? '—'}% chance this hour`)}
          ${cell('Wind', fmtSpeed(c.wind), `Gusts ${fmtSpeed(c.gust)} ${compass(c.windDir)}`)}
          ${cell('UV index', c.isDay ? (c.uv != null ? Math.round(c.uv) : '—') : '0', c.isDay ? 'Daytime' : 'Night')}
          ${cell('Air (US AQI)', air ? air.usAqi : '—', air ? aqiLabel(air.usAqi) : 'Unavailable')}
          ${cell('Humidity', `${c.humidity ?? '—'}%`, '')}
          ${cell('Visibility', c.visibility != null ? fmtDist(c.visibility) : '—', '')}
          ${cell('River flow', river?.available ? `${river.ratio.toFixed(1)}×` : '—', river?.available ? 'Peak vs recent median' : river ? 'No river nearby' : 'Unavailable')}
        </div>
        <p class="small muted">${terr ? (terr.nearestWaterwayM != null ? `Nearest mapped waterway: ${fmtDist(terr.nearestWaterwayM)}${terr.nearestWaterwayName ? ` (${esc(terr.nearestWaterwayName)})` : ''}. ` : 'No mapped waterway within 800 m. ') + (terr.fords.length ? `${terr.fords.length} low-water crossing${terr.fords.length > 1 ? 's' : ''} within 5 km.` : '') : ''} Elevation ${w.elevation != null ? Math.round(w.elevation) + ' m' : 'unknown'}.</p>`;
        $('condTime').textContent = `${w.demo ? 'Demo' : 'Model'} · ${timeAgo(w.updatedAt)}`;
        const hrs = w.hourly.filter((h) => h.time >= Date.now() - 3600_000).slice(0, 12);
        $('ovHours').innerHTML = `<div class="hours" role="table" aria-label="Hourly forecast">${hrs.map((h) => `<div class="hour ${isThunder(h.code) ? 'thunder' : ''}" role="row"><span class="t">${new Date(h.time).getHours().toString().padStart(2, '0')}</span><span class="pbar" title="${h.precipProb ?? 0}% chance of rain"><i style="height:${h.precipProb ?? 0}%"></i></span><span>${h.precipProb ?? 0}%</span><span class="num">${Math.round(getUnits() === 'imperial' ? h.gust * 0.621 : h.gust)}</span></div>`).join('')}</div><p class="small muted">Outlined bars mark forecast thunderstorms. Gusts in ${getUnits() === 'imperial' ? 'mph' : 'km/h'}.</p>`;
      } else {
        $('ovConds').innerHTML = s.sources.weather?.status === 'error' ? `<div class="notice err">${icon('warning')}<div>Weather data is unavailable: ${esc(s.sources.weather.error)}. <button class="btn sm" data-act="refresh" type="button">Try again</button></div></div>` : s.locationMode === 'none' ? '<p class="empty">No location set.</p>' : '<div class="skeleton" style="height:120px"></div>';
        $('ovHours').innerHTML = ''; $('condTime').textContent = '';
      }
      $('ovGaps').innerHTML = `<ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">${[...(a?.gaps || []), ...(a?.confReasons?.length && a.confidence !== 'demo' ? [`Confidence reduced: ${a.confReasons.join(', ')}.`] : []), 'StormShield\'s score is its own estimate. It is not an official warning and a low score does not prove conditions are safe.'].map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`;
      $('ovSources').innerHTML = sourcesList(s);
    },
  },

  // ---------------------------------------------------------------- Map
  map: {
    title: 'Live Hazard Map', short: 'Map', icon: 'map',
    mount(el, ctx) {
      el.innerHTML = `
        <div class="section-h"><h2>Hazard layers</h2></div>
        <p class="small muted">Turn on several layers at once. Select a cell or marker for details, source and update time.</p>
        <div class="layers" id="layerList"></div>
        <section class="card flat"><h3>Legend</h3>
          <div class="legend">
            <span><i style="background:var(--safe)"></i>Low immediate risk</span><span><i style="background:var(--watch)"></i>Developing</span>
            <span><i style="background:var(--warning)"></i>High risk</span><span><i style="background:var(--emergency)"></i>Most urgent</span>
            <span><i style="border:2px dashed var(--warning);background:var(--surface)"></i>Unverified report</span><span><i style="border:2px solid var(--emergency);background:var(--surface)"></i>Verified report</span>
            <span><i style="background:var(--accent);border-radius:50%"></i>Emergency facility</span><span><i style="border:2px dashed var(--ink)"></i>Official warning area</span>
          </div>
          <p class="small muted">Model layers show a 5 × 5 grid of forecast points about 13 km apart. They are estimates, not observations, and update about hourly.</p></section>
        <section class="card"><h3>Monitor another area</h3><p class="small">Tap anywhere on the map to monitor that point instead of your own location. You can return to live tracking at any time.</p>
          <div class="row"><button class="btn" type="button" id="pickArea">${icon('pin')} Choose a point on the map</button><button class="btn ghost" type="button" id="backLive">${icon('locate')} Back to my location</button></div></section>`;
      el.querySelector('#layerList').addEventListener('change', (e) => { const k = e.target.dataset.layer; if (k) ctx.setLayer(k, e.target.checked); });
      el.querySelector('#pickArea').addEventListener('click', () => ctx.pickOnMap('Tap the map to choose an area to monitor', (ll) => ctx.setManual({ lat: ll.lat, lon: ll.lng, label: null })));
      el.querySelector('#backLive').addEventListener('click', () => ctx.locate());
    },
    update(s) {
      const status = (k) => {
        const src = { radar: 'radar', storms: 'grid', flood: 'grid', wind: 'grid', hail: 'grid', heat: 'grid', air: 'airgrid', warnings: 'warnings', community: 'reports', resources: 'resources' }[k];
        const v = s.sources[src];
        if (s.demo.active && ['storms', 'flood', 'wind', 'hail', 'heat', 'air', 'warnings', 'community'].includes(k)) return '<span class="chip demo">Demo</span>';
        if (!v) return '<span class="chip neutral">Not loaded</span>';
        if (v.status === 'ok') return `<span class="chip model">${LAYERS[k].kind === 'official' ? 'Official' : LAYERS[k].kind === 'community' ? 'Community' : LAYERS[k].kind === 'mapped' ? 'Mapped' : LAYERS[k].kind === 'observation' ? 'Radar' : 'Model'}</span>`;
        if (v.status === 'loading') return '<span class="chip neutral">Loading</span>';
        if (v.status === 'not_applicable' || v.status === 'off') return '<span class="chip neutral">Not covered</span>';
        return `<span class="chip warning" title="${esc(v.error || '')}">Unavailable</span>`;
      };
      document.getElementById('layerList').innerHTML = Object.entries(LAYERS).map(([k, L]) => `
        <label class="layer">${icon(L.icon)}<span><span class="nm">${L.label}</span><br><span class="nt">${L.note}</span> ${status(k)}</span>
        <span class="switch"><input type="checkbox" data-layer="${k}" ${s.prefs.layers[k] ? 'checked' : ''} aria-label="${L.label}"></span></label>`).join('');
    },
  },

  // ---------------------------------------------------------------- Journey
  journey: {
    title: 'Journey Safety', short: 'Journey', icon: 'journey',
    mount(el, ctx) {
      el.innerHTML = `
        <h2>Journey safety</h2>
        <div class="notice warn">${icon('car')}<div><b>Do not use StormShield while driving.</b> Check your route before you leave, or ask a passenger. Pull over safely before changing plans.</div></div>
        <section class="card">
          <div class="field"><span>From</span><div class="row" id="jFrom"></div></div>
          <form class="field" id="jForm" autocomplete="off"><label for="jDest">To</label>
            <div class="search"><input id="jDest" type="search" placeholder="Search for a destination" required><button class="btn primary" type="submit">${icon('search')} Find</button></div>
            <span class="hint">Or <button type="button" class="btn ghost sm" id="jPick" style="padding:0;min-height:0">tap a destination on the map</button></span>
          </form>
          <ul class="results" id="jResults"></ul>
        </section>
        <div id="jOut"></div>`;
      const results = el.querySelector('#jResults');
      el.querySelector('#jForm').addEventListener('submit', async (e) => {
        e.preventDefault(); const q = el.querySelector('#jDest').value.trim(); if (!q) return;
        results.innerHTML = '<li class="empty">Searching…</li>';
        try {
          const list = await ctx.search(q);
          results.innerHTML = list.length ? list.map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)}</button></li>`).join('') : '<li class="empty">No places found. Try a nearby town or a full address.</li>';
          results.onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; const p = list[+b.dataset.i]; results.innerHTML = ''; el.querySelector('#jDest').value = p.name; ctx.analyseJourney(p); };
        } catch (err) { results.innerHTML = `<li class="notice err">${icon('warning')} Place search failed: ${esc(err.message)}</li>`; }
      });
      el.querySelector('#jPick').addEventListener('click', () => ctx.pickOnMap('Tap your destination on the map', (ll) => ctx.analyseJourney({ lat: ll.lat, lon: ll.lng, name: `Map point ${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}` })));
      el.querySelector('#jOut').addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (b) ctx.selectRoute(+b.dataset.route); if (e.target.closest('[data-act="rerun"]')) ctx.analyseJourney(null); });
    },
    update(s) {
      document.getElementById('jFrom').innerHTML = s.location ? `${icon('locate')} <span>${esc(s.placeName || `${s.location.lat.toFixed(3)}, ${s.location.lon.toFixed(3)}`)}</span> <span class="loc-mode ${s.locationMode}">${s.locationMode}</span>` : '<span class="muted">Set your location first.</span>';
      const j = s.journey; const out = document.getElementById('jOut');
      if (!j) { out.innerHTML = '<p class="empty">Enter a destination to check weather and hazards along the way.</p>'; return; }
      if (j.status === 'loading') { out.innerHTML = '<div class="card"><p>Finding routes and checking the forecast along each one…</p><div class="skeleton" style="height:60px"></div></div>'; return; }
      if (j.status === 'error') { out.innerHTML = `<div class="notice err">${icon('warning')}<div><b>Route check failed.</b> ${esc(j.error)}<br><button class="btn sm" data-act="rerun" type="button">Try again</button></div></div>`; return; }
      const sel = j.routes.find((r) => r.id === j.selectedId) || j.routes[0];
      const rec = j.routes.find((r) => r.id === j.recommendedId);
      out.innerHTML = `
        ${j.demo ? `<div class="notice demo">${icon('demo')}<div>Route geometry is real, but weather and warnings along it come from the demonstration scenario.</div></div>` : ''}
        <section class="stack"><div class="section-h"><h3>Routes to ${esc(j.toLabel?.split(',')[0] || 'destination')}</h3><span class="small muted">Checked ${clock(j.computedAt)}</span></div>
        ${j.routes.map((r) => `<button class="route" type="button" data-route="${r.id}" aria-pressed="${r.id === sel.id}">
          <div class="route-h"><b>${r.id === 0 ? 'Fastest route' : `Alternative ${r.id}`}${r.id === j.recommendedId && j.routes.length > 1 ? ' · Recommended' : ''}</b><span class="chip ${r.rating.css}">${r.rating.rating}</span></div>
          <div class="row small muted"><span class="num">${fmtDist(r.distance)}</span><span>·</span><span class="num">${Math.round(r.duration / 60)} min</span><span>·</span><span>${r.samples} forecast points</span></div>
          ${r.hazards.length ? `<ul>${dedupe(r.hazards).slice(0, 4).map((h) => `<li>${esc(h.label)} <span class="muted">(${esc(h.detail || '')})</span></li>`).join('')}</ul>` : '<p class="small">No hazards found in the available data. This does not prove the route is safe.</p>'}
        </button>`).join('')}</section>
        ${j.reasons.length ? `<div class="notice">${icon('route')}<div><b>Why ${rec.id === 0 ? 'the fastest route' : `alternative ${rec.id}`} is suggested.</b> ${esc(j.reasons.join(' '))}</div></div>` : ''}
        ${sel.rating.css === 'emergency' ? `<div class="notice err">${icon('warning')}<div><b>This route may be unsafe.</b> Consider delaying travel. Never drive into flood water.</div></div>` : ''}
        <section class="card flat"><h3>Limits of this check</h3><ul class="small" style="margin:0;padding-left:18px">${j.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>
        <button class="btn" type="button" data-act="rerun">${icon('refresh')} Re-check with latest data</button>`;
    },
  },

  // ---------------------------------------------------------------- Resources
  resources: {
    title: 'Nearby Resources', short: 'Help', icon: 'resources',
    filter: 'all',
    mount(el, ctx) {
      el.innerHTML = `<h2>Nearby help</h2><section id="rNumbers"></section>
        <div class="filters" id="rFilters" role="group" aria-label="Filter facilities"></div>
        <section class="card"><div class="section-h"><h3>Facilities</h3><button class="btn sm" type="button" id="rReload">${icon('refresh')} Reload</button></div><div id="rList"></div></section>
        <section class="card flat"><h3>Infrastructure and outages</h3><div id="rInfra" class="small"></div></section>`;
      el.querySelector('#rFilters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; this.filter = b.dataset.f; this.update(ctx.state); });
      el.querySelector('#rReload').addEventListener('click', () => ctx.loadResources(true));
      el.querySelector('#rList').addEventListener('click', (e) => { const b = e.target.closest('[data-fly]'); if (b) ctx.flyTo(+b.dataset.lat, +b.dataset.lon); });
      ctx.loadResources(false);
    },
    update(s) {
      const cc = s.countryCode; const nums = EMERGENCY_NUMBERS[cc];
      document.getElementById('rNumbers').innerHTML = `<div class="card"><div class="section-h"><h3>Emergency numbers</h3><span class="small muted">${cc ? esc(cc.toUpperCase()) : 'Country unknown'}</span></div>
        ${nums ? `<div class="numbers">${nums.map(([n, l]) => `<div class="number"><b class="num">${n}</b><span>${l}</span></div>`).join('')}</div>` : '<p class="small">StormShield does not have a checked number list for this country. Look up your local emergency number now, before you need it. 112 works on many mobile networks worldwide, but not everywhere.</p>'}
        <p class="small muted">Tap and hold a number to copy it. Always confirm local numbers with your authorities.</p></div>`;
      const types = ['all', ...Object.keys(RESOURCE_TYPES)];
      const list = s.resources?.items || [];
      document.getElementById('rFilters').innerHTML = types.filter((t) => t === 'all' || list.some((r) => r.type === t)).map((t) => `<button type="button" data-f="${t}" aria-pressed="${this.filter === t}">${t === 'all' ? 'All' : RESOURCE_TYPES[t].label}</button>`).join('');
      const el = document.getElementById('rList');
      if (!s.location) el.innerHTML = '<p class="empty">Set a location to find nearby facilities.</p>';
      else if (!s.resources || s.resources.status === 'loading') el.innerHTML = '<div class="skeleton" style="height:80px"></div>';
      else if (s.resources.status === 'error') el.innerHTML = `<div class="notice err">${icon('warning')}<div>Facility directory is unavailable: ${esc(s.resources.error)}. Search for verified services on your government or municipal website, or <a href="https://www.openstreetmap.org/#map=13/${s.location.lat}/${s.location.lon}" target="_blank" rel="noopener">browse the map on OpenStreetMap</a>.</div></div>`;
      else {
        const items = list.filter((r) => this.filter === 'all' || r.type === this.filter).slice(0, 40);
        el.innerHTML = items.length ? `<div class="list">${items.map((r) => `<div class="item"><span class="ico">${icon(r.type)}</span><div style="min-width:0"><div class="ttl">${esc(r.name)}</div><div class="meta">${esc(r.label)}${r.note ? ` · ${esc(r.note)}` : ''}${r.emergencyDept === true ? ' · Emergency department listed' : ''}</div>${r.address ? `<div class="meta">${esc(r.address)}</div>` : ''}${r.phone ? `<div class="meta">Phone: <span class="num" style="user-select:all">${esc(r.phone)}</span></div>` : ''}
          <div class="item-actions"><button class="btn sm" type="button" data-fly data-lat="${r.lat}" data-lon="${r.lon}">${icon('pin')} Show on map</button><a class="btn sm" href="https://www.openstreetmap.org/directions?route=${s.location.lat},${s.location.lon};${r.lat},${r.lon}" target="_blank" rel="noopener">${icon('external')} Directions</a></div></div><span class="right">${fmtDist(r.distance)}</span></div>`).join('')}</div>
          <p class="small muted">Facilities are mapped by the OpenStreetMap community. Opening hours and current operating status are not known. Shelters are only shown where they are mapped; StormShield never invents shelter locations.</p>`
          : `<p class="empty">No ${this.filter === 'all' ? 'emergency facilities are' : RESOURCE_TYPES[this.filter].label.toLowerCase() + 's are'} mapped within 15 km.</p>`;
      }
      const outages = (s.reports || []).filter((r) => ['power_outage', 'water_outage', 'flooded_road', 'fallen_tree'].includes(r.category) && !['resolved', 'expired', 'rejected'].includes(r.status));
      document.getElementById('rInfra').innerHTML = `<p>Official road-closure and utility-outage feeds are not connected in this prototype. Community reports nearby:</p>
        ${outages.length ? `<ul style="margin:6px 0 0;padding-left:18px">${outages.map((r) => `<li><b>${esc(r.categoryLabel)}</b> <span class="chip ${r.status === 'verified' ? 'verified' : 'unverified'}">${r.status === 'verified' ? 'Verified' : 'Unverified'}</span> ${esc(r.description)} <span class="muted">(${timeAgo(r.observedAt)})</span></li>`).join('')}</ul>` : '<p class="muted">None reported.</p>'}`;
    },
  },

  // ---------------------------------------------------------------- Reports
  reports: {
    title: 'Community Reports', short: 'Reports', icon: 'reports',
    form: { category: null, lat: null, lon: null, photo: null, locSource: null },
    mount(el, ctx) {
      el.innerHTML = `
        <h2>Community reports</h2>
        <p class="small muted">Reports from people nearby help others, but they are unverified until a moderator checks them. They never replace official warnings.</p>
        <section class="card" aria-labelledby="newRepH"><h3 id="newRepH">Report a hazard</h3>
          <form id="repForm" class="stack" novalidate>
            <fieldset style="border:0;padding:0;margin:0" class="stack"><legend class="field" style="margin-bottom:4px">What did you see?</legend><div class="cats" id="repCats"></div></fieldset>
            <label class="field" for="repDesc">Description<span class="hint">What, where exactly, how bad. 10–500 characters.</span><textarea id="repDesc" maxlength="500" required></textarea></label>
            <div class="field"><span>Location</span><div class="row"><button class="btn sm" type="button" id="repUseLoc">${icon('locate')} Use my location</button><button class="btn sm" type="button" id="repPick">${icon('pin')} Pick on map</button></div><span class="hint" id="repLocTxt">No location set.</span></div>
            <label class="field" for="repTime">Time observed<input id="repTime" type="datetime-local"></label>
            <div class="field"><span>Photo (optional)</span><input id="repPhoto" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Attach photo"><span class="hint">Photos are only shown publicly after a moderator verifies the report. Avoid faces and number plates.</span><img id="repPrev" class="photo-prev" alt="Selected photo preview" hidden></div>
            <div id="repMsg"></div>
            <button class="btn primary" type="submit" id="repSubmit">Submit report</button>
          </form>
        </section>
        <section class="card"><div class="section-h"><h3>Nearby reports</h3><button class="btn sm" type="button" id="repReload">${icon('refresh')} Reload</button></div><div id="repList"></div></section>
        <section class="card"><h3>Your reports</h3><div id="repMine"></div></section>
        <section class="card flat small"><h3>How verification works</h3>
          <div class="steps"><span>Submitted</span><span>Under review</span><span>Verified</span><span>Resolved</span></div>
          <p>New reports show as <b>unverified</b>. When three different devices confirm the same report it moves to <b>under review</b>, which puts it first in the moderator queue. Only a moderator can mark a report <b>verified</b> or reject it. Reports expire automatically, for example after 3 hours for lightning and 48 hours for a fallen tree. Three "cleared" votes mark a report resolved.</p>
          <p>Safeguards: rate limit per device and network, duplicate merging within 250 m and one hour, offensive language and links blocked, photos hidden until verified.</p></section>`;
      const cats = el.querySelector('#repCats');
      const CATS = { flooded_road: 'Flooded road', strong_wind: 'Strong wind', fallen_tree: 'Fallen tree', lightning: 'Lightning', hail: 'Hail damage', power_outage: 'Power failure', building_damage: 'Building damage', water_outage: 'Water outage', other: 'Other' };
      cats.innerHTML = Object.entries(CATS).map(([k, l]) => `<button class="cat" type="button" data-cat="${k}" aria-pressed="false">${icon(k)}${l}</button>`).join('');
      cats.addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; this.form.category = b.dataset.cat; cats.querySelectorAll('.cat').forEach((c) => c.setAttribute('aria-pressed', c === b)); });
      const t = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      el.querySelector('#repTime').value = t;
      const setLoc = (lat, lon, src) => { this.form.lat = lat; this.form.lon = lon; this.form.locSource = src; el.querySelector('#repLocTxt').textContent = `${src === 'gps' ? 'Your location' : 'Map point'}: ${lat.toFixed(4)}, ${lon.toFixed(4)}`; };
      el.querySelector('#repUseLoc').addEventListener('click', () => { const l = ctx.state.location; if (l && ctx.state.locationMode !== 'manual') setLoc(l.lat, l.lon, 'gps'); else ctx.locate().then((ok) => { const l2 = ctx.state.location; if (ok && l2) setLoc(l2.lat, l2.lon, 'gps'); else ctx.toast('Location unavailable. Pick the spot on the map instead.'); }); });
      el.querySelector('#repPick').addEventListener('click', () => ctx.pickOnMap('Tap where the incident is', (ll) => setLoc(ll.lat, ll.lng, 'map')));
      el.querySelector('#repPhoto').addEventListener('change', async (e) => {
        const f = e.target.files[0]; const prev = el.querySelector('#repPrev');
        if (!f) { this.form.photo = null; prev.hidden = true; return; }
        try { this.form.photo = await downscale(f); prev.src = this.form.photo; prev.hidden = false; }
        catch { this.form.photo = null; prev.hidden = true; ctx.toast('That image could not be read.'); }
      });
      el.querySelector('#repForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = el.querySelector('#repMsg'); const btn = el.querySelector('#repSubmit');
        const desc = el.querySelector('#repDesc').value.trim();
        const errs = [];
        if (!this.form.category) errs.push('Choose what you saw.');
        if (desc.length < 10) errs.push('Add a description of at least 10 characters.');
        if (this.form.lat == null) errs.push('Set the incident location.');
        if (errs.length) { msg.innerHTML = `<div class="notice err">${icon('warning')}<div>${errs.join(' ')}</div></div>`; return; }
        btn.disabled = true; btn.textContent = 'Submitting…'; msg.innerHTML = '';
        try {
          const precise = ctx.state.prefs.preciseReports;
          const round = (v) => (precise ? v : Math.round(v * 500) / 500);
          const res = await ctx.submitReport({ category: this.form.category, description: desc, lat: round(this.form.lat), lon: round(this.form.lon), observedAt: new Date(el.querySelector('#repTime').value).getTime() || Date.now(), photo: this.form.photo });
          msg.innerHTML = `<div class="notice">${icon('check')}<div><b>${res.merged ? 'Added as a confirmation.' : 'Report received.'}</b> ${esc(res.message || '')} Status: <span class="chip ${res.report.status}">${STATUS[res.report.status]}</span>. It is visible to people nearby as unverified until a moderator checks it.</div></div>`;
          el.querySelector('#repForm').reset(); el.querySelector('#repPrev').hidden = true;
          el.querySelector('#repTime').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          this.form = { category: null, lat: null, lon: null, photo: null }; el.querySelector('#repLocTxt').textContent = 'No location set.';
          cats.querySelectorAll('.cat').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        } catch (err) {
          msg.innerHTML = `<div class="notice err">${icon('warning')}<div><b>Not submitted.</b> ${esc(err.message)}</div></div>`;
        } finally { btn.disabled = false; btn.textContent = 'Submit report'; }
      });
      el.querySelector('#repReload').addEventListener('click', () => ctx.loadReports());
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-vote]'); const f = e.target.closest('[data-fly]');
        if (f) ctx.flyTo(+f.dataset.lat, +f.dataset.lon);
        if (!b) return;
        b.disabled = true;
        try { await ctx.vote(b.dataset.id, b.dataset.vote); ctx.toast(b.dataset.vote === 'confirm' ? 'Thanks. Your confirmation was recorded.' : 'Marked as cleared.'); }
        catch (err) { ctx.toast(err.message); b.disabled = false; }
      });
      ctx.loadMine();
    },
    update(s) {
      const list = document.getElementById('repList');
      const src = s.sources.reports;
      if (!s.location) list.innerHTML = '<p class="empty">Set a location to see nearby reports.</p>';
      else if (src?.status === 'error' && !s.demo.active) list.innerHTML = `<div class="notice err">${icon('warning')}<div>Community reports are unavailable: ${esc(src.error)}. The StormShield server may not be running.</div></div>`;
      else list.innerHTML = s.reports.length ? `<div class="list">${s.reports.map((r) => reportItem(r, true)).join('')}</div>` : '<p class="empty">No active reports within 30 km.</p>';
      const mine = document.getElementById('repMine');
      mine.innerHTML = s.myReports?.length ? `<div class="list">${s.myReports.map((r) => reportItem(r, false)).join('')}</div>` : '<p class="empty">You have not submitted any reports from this device.</p>';
    },
  },

  // ---------------------------------------------------------------- Alerts
  alerts: {
    title: 'Alerts', short: 'Alerts', icon: 'alerts',
    mount(el) {
      el.innerHTML = `<h2>Alerts</h2>
        <section class="stack"><div class="section-h"><h3>Official warnings</h3><span class="small muted" id="alOffMeta"></span></div><div class="stack" id="alOfficial"></div></section>
        <section class="stack"><div class="section-h"><h3>StormShield alerts</h3><span class="small muted">Our estimate from forecast data</span></div><div class="stack" id="alOwn"></div></section>
        <section class="card"><h3>Recent changes</h3><div id="alLog"></div></section>`;
    },
    update(s) {
      const w = s.sources.warnings; const off = s.conditions?.warnings || [];
      document.getElementById('alOffMeta').textContent = w?.updatedAt ? `Checked ${timeAgo(w.updatedAt)}` : '';
      let offHtml;
      if (s.demo.active) offHtml = off.length ? off.map(officialCard).join('') : '<p class="empty">No demonstration warnings in this scenario.</p>';
      else if (!w || w.status === 'loading') offHtml = '<div class="skeleton" style="height:60px"></div>';
      else if (w.status === 'error') offHtml = `<div class="notice err">${icon('warning')}<div>Official warnings could not be checked: ${esc(w.error)}. Check your national weather service directly.</div></div>`;
      else if (s.conditions?.warningsCoverage === 'none') offHtml = `<div class="notice warn">${icon('info')}<div><b>No official warnings feed is connected for this location.</b> StormShield cannot confirm whether warnings are in force. Check your national weather service${s.countryCode === 'za' ? ' (South African Weather Service, weathersa.co.za)' : ''}. Developers can add a CAP feed or OpenWeather key, see the README.</div></div>`;
      else offHtml = off.length ? off.map(officialCard).join('') : `<div class="notice">${icon('official')}<div>No active official warnings for your location from the connected sources (${esc((w.sourcesOk || []).join(', '))}).</div></div>`;
      document.getElementById('alOfficial').innerHTML = offHtml;
      const a = s.assessment;
      const own = a?.hazards.filter((h) => !h.official) || [];
      document.getElementById('alOwn').innerHTML = !a ? '<p class="empty">No assessment yet.</p>' : own.length ? own.map((h) => actionCard(h, a.activity, true)).join('') : '<p class="empty">No StormShield alerts. No hazard crossed our thresholds.</p>';
      const log = [...s.history.map((h) => ({ at: h.at, html: `Score ${h.from ?? '–'} → <b>${h.to}</b> (${h.level}). ${esc(h.reasons.join(' '))}` })), ...s.alertsLog.map((l) => ({ at: l.at, html: esc(l.text) }))].sort((x, y) => y.at - x.at).slice(0, 30);
      document.getElementById('alLog').innerHTML = log.length ? `<div class="list">${log.map((l) => `<div class="item" style="grid-template-columns:52px 1fr"><span class="num small muted">${clock(l.at)}</span><span class="small">${l.html}</span></div>`).join('')}</div>` : '<p class="empty">No changes recorded this session.</p>';
    },
  },

  // ---------------------------------------------------------------- Settings
  settings: {
    title: 'Settings', short: 'Settings', icon: 'settings',
    mount(el, ctx) {
      el.innerHTML = `<h2>Settings</h2>
        <section class="card"><h3>Location</h3>
          <p class="small" id="setLocState"></p>
          <label class="switch"><span>Follow my location as I move<br><span class="small muted">Uses continuous GPS while this page is open</span></span><input type="checkbox" id="setFollow"></label>
          <div class="row"><button class="btn" type="button" id="setLocate">${icon('locate')} Use my location</button><button class="btn ghost" type="button" id="setStop">Stop tracking</button></div>
          <form class="search" id="setSearch" role="search"><label class="sr" for="setQ">Monitor a place</label><input id="setQ" type="search" placeholder="Monitor a place instead"><button class="btn" type="submit">Search</button></form><ul class="results" id="setResults"></ul>
        </section>
        <section class="card"><h3>Display</h3>
          <div class="field"><span>Theme</span><div class="seg" id="setTheme"><button type="button" data-v="light">Light</button><button type="button" data-v="dark">Dark</button><button type="button" data-v="system">System</button></div></div>
          <div class="field"><span>Units</span><div class="seg" id="setUnits"><button type="button" data-v="metric">Metric (°C, km/h, mm)</button><button type="button" data-v="imperial">Imperial (°F, mph, in)</button></div></div>
        </section>
        <section class="card"><h3>Your activity</h3><p class="small muted">Activity changes how exposed you are. Automatic uses your speed only when GPS reports it.</p>
          <div class="seg" id="setAct"><button type="button" data-v="auto">Automatic</button><button type="button" data-v="indoors">Indoors</button><button type="button" data-v="outdoors">Outdoors / working outside</button><button type="button" data-v="driving">Travelling by road</button></div></section>
        <section class="card"><h3>Alert preferences</h3>
          <label class="switch"><span>Browser notifications<br><span class="small muted" id="setNotifyState"></span></span><input type="checkbox" id="setNotify"></label>
          <div class="field"><span>Notify me from</span><div class="seg" id="setNotifyMin"><button type="button" data-v="WATCH">Watch</button><button type="button" data-v="WARNING">Warning</button><button type="button" data-v="EMERGENCY">Emergency only</button></div></div>
        </section>
        <section class="card"><h3>Privacy</h3>
          <label class="switch"><span>Share precise location in reports<br><span class="small muted">Off rounds report locations to about 200 m</span></span><input type="checkbox" id="setPrecise"></label>
          <p class="small muted">Your location is used in this browser to request forecasts from the providers listed under Data sources. It is sent to the StormShield server only for warnings lookups and when you submit a report. Nothing is stored on the server about where you are unless you submit a report.</p>
          <button class="btn danger" type="button" id="setClear">Clear saved settings on this device</button><div id="setClearMsg"></div>
        </section>
        <section class="card"><h3>Demonstration mode</h3><p class="small">Load a scenario to see how StormShield behaves in severe weather. Demonstration data is labelled everywhere and replaces live data until you turn it off.</p>
          <div class="stack" id="setDemo"></div></section>
        <section class="card"><h3>Moderator tools</h3><p class="small muted">For deployments with a moderator token (ADMIN_TOKEN). Verification is only possible here.</p>
          <form class="search" id="modForm"><label class="sr" for="modToken">Moderator token</label><input id="modToken" type="password" placeholder="Moderator token" autocomplete="off"><button class="btn" type="submit">Open queue</button></form><div id="modOut"></div></section>
        <section class="card flat small"><h3>About</h3><p>StormShield prototype. Forecasts by Open-Meteo, air quality by Copernicus CAMS, river flow by GloFAS, radar by RainViewer, maps and facilities by OpenStreetMap contributors and CARTO, routing by OSRM. Not an official warning service. In an emergency, contact local emergency services.</p></section>`;
      const seg = (id, key, fn) => el.querySelector(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) (fn || ((v) => ctx.setPref(key, v)))(b.dataset.v); });
      seg('#setTheme', 'theme', (v) => ctx.setTheme(v)); seg('#setUnits', 'units', (v) => ctx.setUnits(v)); seg('#setAct', 'activity'); seg('#setNotifyMin', 'notifyMin');
      el.querySelector('#setFollow').addEventListener('change', (e) => ctx.setFollow(e.target.checked));
      el.querySelector('#setPrecise').addEventListener('change', (e) => ctx.setPref('preciseReports', e.target.checked));
      el.querySelector('#setNotify').addEventListener('change', async (e) => { const ok = await ctx.enableNotifications(e.target.checked); e.target.checked = ok; });
      el.querySelector('#setLocate').addEventListener('click', () => ctx.locate());
      el.querySelector('#setStop').addEventListener('click', () => ctx.stopTracking());
      el.querySelector('#setClear').addEventListener('click', () => { ctx.clearLocal(); el.querySelector('#setClearMsg').innerHTML = '<p class="small">Saved settings cleared. Reload the page to start fresh.</p>'; });
      const results = el.querySelector('#setResults');
      el.querySelector('#setSearch').addEventListener('submit', async (e) => {
        e.preventDefault(); const q = el.querySelector('#setQ').value.trim(); if (!q) return;
        results.innerHTML = '<li class="empty">Searching…</li>';
        try {
          const list = await ctx.search(q);
          results.innerHTML = list.length ? list.map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)}</button></li>`).join('') : '<li class="empty">No places found.</li>';
          results.onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; results.innerHTML = ''; ctx.setManual({ ...list[+b.dataset.i], label: list[+b.dataset.i].name }); };
        } catch (err) { results.innerHTML = `<li class="notice err">${esc(err.message)}</li>`; }
      });
      el.querySelector('#setDemo').addEventListener('click', (e) => { const b = e.target.closest('[data-demo]'); if (!b) return; if (b.dataset.demo === 'off') ctx.stopDemo(); else ctx.startDemo(b.dataset.demo); });
      el.querySelector('#modForm').addEventListener('submit', async (e) => { e.preventDefault(); this.token = el.querySelector('#modToken').value; await this.loadQueue(ctx); });
      el.querySelector('#modOut').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-mod]'); if (!b) return;
        try { await ctx.admin.set(this.token, b.dataset.id, b.dataset.mod, b.closest('.item').querySelector('input')?.value || ''); ctx.toast(`Report marked ${STATUS[b.dataset.mod].toLowerCase()}.`); await this.loadQueue(ctx); ctx.loadReports(); }
        catch (err) { ctx.toast(err.message); }
      });
    },
    async loadQueue(ctx) {
      const out = document.getElementById('modOut'); out.innerHTML = '<div class="skeleton" style="height:40px"></div>';
      try {
        const { reports } = await ctx.admin.list(this.token);
        out.innerHTML = reports.length ? `<div class="list">${reports.map((r) => `<div class="item"><span class="ico">${icon(r.category)}</span><div style="min-width:0"><div class="ttl">${esc(r.categoryLabel)} <span class="chip ${r.status}">${STATUS[r.status]}</span></div><div class="meta">${esc(r.description)}</div><div class="meta">${r.lat}, ${r.lon} · observed ${timeAgo(r.observedAt)} · ${r.confirmations} confirmations${r.hasPhoto ? ` · <a href="/api/reports/${r.id}/photo?token=${encodeURIComponent(this.token)}" target="_blank" rel="noopener">photo</a>` : ''}</div>
          <input type="text" placeholder="Note (optional)" aria-label="Moderator note" style="margin-top:6px">
          <div class="item-actions"><button class="btn sm" data-mod="verified" data-id="${r.id}" type="button">Verify</button><button class="btn sm" data-mod="resolved" data-id="${r.id}" type="button">Resolve</button><button class="btn sm danger" data-mod="rejected" data-id="${r.id}" type="button">Reject</button></div></div><span></span></div>`).join('')}</div>` : '<p class="empty">The queue is empty.</p>';
      } catch (err) { out.innerHTML = `<div class="notice err">${icon('warning')}<div>${esc(err.message)}</div></div>`; }
    },
    update(s) {
      const pressed = (id, v) => document.querySelectorAll(`${id} button`).forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === v));
      pressed('#setTheme', s.prefs.theme); pressed('#setUnits', s.prefs.units); pressed('#setAct', s.prefs.activity); pressed('#setNotifyMin', s.prefs.notifyMin);
      document.getElementById('setFollow').checked = s.prefs.follow;
      document.getElementById('setPrecise').checked = s.prefs.preciseReports;
      document.getElementById('setNotify').checked = s.prefs.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
      document.getElementById('setNotifyState').textContent = typeof Notification === 'undefined' ? 'Not supported in this browser' : Notification.permission === 'denied' ? 'Blocked in browser settings' : 'Alerts when your risk level rises';
      const ls = { idle: 'Location not requested yet.', requesting: 'Waiting for location permission…', ok: s.locationMode === 'following' ? 'Following your location.' : s.locationMode === 'fixed' ? 'Using your location from a single reading.' : `Monitoring a chosen area${s.placeName ? `: ${s.placeName}` : ''}.`, denied: 'Location permission was denied. Allow it in your browser\'s site settings, then try again, or monitor a place instead.', unavailable: 'Your device could not determine a location.', timeout: 'Getting your location took too long.', unsupported: 'This browser does not support location.' };
      document.getElementById('setLocState').textContent = s.locationMode === 'manual' ? ls.ok : ls[s.locationStatus] || '';
      document.getElementById('setDemo').innerHTML = Object.entries(SCENARIOS).map(([k, v]) => `<button class="btn ${s.demo.scenario === k ? 'primary' : ''}" type="button" data-demo="${k}" aria-pressed="${s.demo.scenario === k}">${icon(v.icon)} ${v.label}</button>`).join('') + (s.demo.active ? `<button class="btn ghost" type="button" data-demo="off">Turn off demonstration mode</button>` : '');
    },
  },
};

const STATUS = { submitted: 'Submitted', under_review: 'Under review', verified: 'Verified', resolved: 'Resolved', rejected: 'Rejected', expired: 'Expired' };
export { STATUS };

function reportItem(r, actions) {
  const active = !['resolved', 'expired', 'rejected'].includes(r.status);
  return `<div class="item"><span class="ico">${icon(r.category)}</span><div style="min-width:0">
    <div class="ttl">${esc(r.categoryLabel)} <span class="chip ${r.status}">${STATUS[r.status]}</span>${r.demo ? ' <span class="chip demo">Demo</span>' : ''}</div>
    <div class="meta">${esc(r.description)}</div>
    <div class="meta">Observed ${timeAgo(r.observedAt)} · ${r.confirmations} confirmation${r.confirmations === 1 ? '' : 's'}${r.status !== 'verified' && active ? ' · not verified' : ''}${r.moderatorNote ? ` · Moderator: ${esc(r.moderatorNote)}` : ''}</div>
    ${r.hasPhoto && !r.demo ? `<img class="photo-prev" loading="lazy" src="/api/reports/${r.id}/photo?clientId=${encodeURIComponent(localStorageClient())}" alt="Photo attached to the report">` : ''}
    <div class="item-actions"><button class="btn sm" type="button" data-fly data-lat="${r.lat}" data-lon="${r.lon}">${icon('pin')} Map</button>${actions && active && !r.own && !r.demo ? `<button class="btn sm" type="button" data-vote="confirm" data-id="${r.id}">${icon('check')} I see this too</button><button class="btn sm" type="button" data-vote="clear" data-id="${r.id}">Cleared</button>` : ''}</div>
  </div><span class="right">${r.distance != null ? fmtDist(r.distance) : ''}</span></div>`;
}
function localStorageClient() { try { return JSON.parse(localStorage.getItem('ss.clientId')) || ''; } catch { return ''; } }

function dedupe(hz) { const seen = new Set(); return hz.filter((h) => (seen.has(h.label) ? false : seen.add(h.label))); }

async function downscale(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

// Checked national numbers only. Countries not listed show a "look it up" message instead of a guess.
export const EMERGENCY_NUMBERS = {
  za: [['10111', 'Police'], ['10177', 'Ambulance & fire'], ['112', 'From any mobile']],
  gb: [['999', 'All emergencies'], ['112', 'All emergencies']],
  ie: [['112', 'All emergencies'], ['999', 'All emergencies']],
  us: [['911', 'All emergencies']], ca: [['911', 'All emergencies']],
  au: [['000', 'All emergencies'], ['112', 'From mobiles']], nz: [['111', 'All emergencies']],
  ke: [['999', 'All emergencies'], ['112', 'All emergencies']],
  in: [['112', 'All emergencies']],
  ...Object.fromEntries(['de', 'fr', 'es', 'it', 'nl', 'be', 'pt', 'at', 'se', 'dk', 'fi', 'pl', 'gr', 'cz', 'hu', 'ro', 'bg', 'hr', 'si', 'sk', 'lt', 'lv', 'ee', 'lu', 'mt', 'cy'].map((c) => [c, [['112', 'All emergencies (EU)']]])),
};

export { RISK_CONFIG };
