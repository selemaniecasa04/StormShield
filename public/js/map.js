// Map rendering: base map, user position, hazard layers, resources, reports and routes.
/* global L */
import { icon } from './ui/icons.js';
import { esc, timeAgo, fmtTemp, fmtSpeed, fmtPrecip, fmtDist, compass, WMO, isThunder, dateTime } from './util.js';

export const LAYERS = {
  radar: { label: 'Rain radar', icon: 'storm', note: 'RainViewer composite, ~10 min old', kind: 'observation' },
  storms: { label: 'Thunderstorms', icon: 'lightning', note: 'Model forecast, next 6 h', kind: 'forecast' },
  flood: { label: 'Flooding', icon: 'flood', note: 'Rain totals, fords, river flow', kind: 'forecast' },
  wind: { label: 'Wind & gusts', icon: 'wind', note: 'Model analysis, hourly', kind: 'forecast' },
  hail: { label: 'Hail', icon: 'hail', note: 'Model forecast, next 6 h', kind: 'forecast' },
  heat: { label: 'Heat (feels like)', icon: 'heat', note: 'Model analysis, hourly', kind: 'forecast' },
  air: { label: 'Air quality', icon: 'air', note: 'CAMS model, hourly', kind: 'forecast' },
  warnings: { label: 'Official warnings', icon: 'official', note: 'Where a feed is connected', kind: 'official' },
  community: { label: 'Community reports', icon: 'reports', note: 'User submitted', kind: 'community' },
  resources: { label: 'Emergency resources', icon: 'resources', note: 'OpenStreetMap', kind: 'mapped' },
};

const RISK = { safe: 'var(--safe)', watch: 'var(--watch)', warning: 'var(--warning)', emergency: 'var(--emergency)' };
const cls = (sev) => (sev >= 0.85 ? 'emergency' : sev >= 0.6 ? 'warning' : sev >= 0.3 ? 'watch' : 'safe');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class HazardMap {
  constructor(el, { onMapClick } = {}) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true, preferCanvas: true }).setView([0, 20], 3);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.groups = Object.fromEntries(Object.keys(LAYERS).map((k) => [k, L.layerGroup()]));
    this.userGroup = L.layerGroup().addTo(this.map);
    this.journeyGroup = L.layerGroup().addTo(this.map);
    this.pickGroup = L.layerGroup().addTo(this.map);
    this.radarLayer = null;
    this.setTheme(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
    this.map.on('click', (e) => onMapClick?.(e.latlng));
  }
  setTheme(dark) {
    if (this.base) this.map.removeLayer(this.base);
    const style = dark ? 'dark_all' : 'light_all';
    this.base = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(this.map);
    this.base.bringToBack();
  }
  setVisible(layers) {
    for (const [k, g] of Object.entries(this.groups)) {
      const on = Boolean(layers[k]);
      if (on && !this.map.hasLayer(g)) g.addTo(this.map);
      if (!on && this.map.hasLayer(g)) this.map.removeLayer(g);
    }
    if (this.radarLayer) { if (layers.radar) this.radarLayer.addTo(this.map); else this.map.removeLayer(this.radarLayer); }
  }
  invalidate() { setTimeout(() => this.map.invalidateSize(), 60); }

  // ---------- User position ----------
  setUser(loc, mode, { recentre } = {}) {
    this.userGroup.clearLayers();
    if (!loc) return;
    const ll = [loc.lat, loc.lon];
    if (loc.accuracy && mode === 'following' || (loc.accuracy && mode === 'fixed')) {
      L.circle(ll, { radius: loc.accuracy, color: cssVar('--accent'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(this.userGroup);
    }
    const heading = Number.isFinite(loc.heading) && (loc.speed ?? 0) > 0.5 ? loc.heading : null;
    const html = mode === 'manual'
      ? `<div class="m-area" role="img" aria-label="Monitored area">${icon('pin')}</div>`
      : `<div class="m-user" role="img" aria-label="Your position">${heading != null ? `<span class="m-heading" style="transform:rotate(${heading}deg)"></span>` : ''}<span class="m-dot"></span></div>`;
    L.marker(ll, { icon: L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, mode === 'manual' ? 26 : 14] }), keyboard: false, zIndexOffset: 1000 })
      .bindTooltip(mode === 'manual' ? 'Monitored area' : `You are here${loc.accuracy ? ` (±${fmtDist(loc.accuracy)})` : ''}`).addTo(this.userGroup);
    if (recentre) this.map.setView(ll, Math.max(this.map.getZoom(), 11));
  }
  recentre(loc) { if (loc) this.map.setView([loc.lat, loc.lon], Math.max(this.map.getZoom(), 12)); }

  // ---------- Model grid overlays ----------
  setGrid(grid, meta, { demo } = {}) {
    ['storms', 'flood', 'wind', 'hail', 'heat'].forEach((k) => this.groups[k].clearLayers());
    if (!grid?.length) return;
    const { step, stepLon } = meta;
    const src = demo ? 'DEMONSTRATION DATA' : 'Open-Meteo model';
    const cell = (p, group, sev, title, body, glyph) => {
      if (sev < 0.15) return;
      const b = [[p.lat - step / 2, p.lon - stepLon / 2], [p.lat + step / 2, p.lon + stepLon / 2]];
      const c = cls(sev);
      L.rectangle(b, { stroke: sev >= 0.3, weight: 1, color: cssVar('--' + c), opacity: 0.5, fillColor: cssVar('--' + c), fillOpacity: 0.05 + sev * 0.16 })
        .bindPopup(popup(title, c, body, src, p.time, demo)).addTo(this.groups[group]);
      if (glyph && sev >= 0.3) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="m-glyph ${c}">${icon(glyph)}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false, keyboard: false }).addTo(this.groups[group]);
    };
    for (const p of grid) {
      const tSev = p.thunder6h ? (isThunder(p.code) ? 0.7 : 0.45) : 0;
      cell(p, 'storms', tSev, isThunder(p.code) ? 'Thunderstorm in progress' : 'Thunderstorms forecast', `Weather: ${WMO[p.code] || '—'}. Thunderstorm conditions appear in the next 6 hours at this grid point.<br><b>Do:</b> plan shelter in a solid building.`, 'lightning');
      const fSev = p.precip6h >= 110 ? 0.88 : p.precip6h >= 70 ? 0.7 : p.precip6h >= 40 ? 0.45 : p.precip6h >= 20 ? 0.25 : 0;
      cell(p, 'flood', fSev, 'Heavy rain total', `${fmtPrecip(p.precip6h)} forecast over 6 hours (${fmtPrecip(p.precip)} in the last hour).<br><b>Do:</b> avoid low-lying roads and crossings.`, 'flood');
      const g = Math.max(p.gust || 0, p.gust6h || 0);
      const wSev = g >= 110 ? 0.88 : g >= 90 ? 0.68 : g >= 75 ? 0.48 : g >= 62 ? 0.3 : g >= 50 ? 0.15 : 0;
      cell(p, 'wind', wSev, 'Strong gusts', `Gusts ${fmtSpeed(p.gust)} now, up to ${fmtSpeed(p.gust6h)} in 6 h. Mean wind ${fmtSpeed(p.wind)} from ${compass(p.windDir)}.<br><b>Do:</b> secure loose objects and avoid trees.`, null);
      // Wind arrows are shown even in calm cells so direction is visible
      const arrowC = cls(wSev);
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="m-wind ${arrowC}" style="transform:rotate(${(p.windDir ?? 0) + 180}deg)" title="${Math.round(p.gust || 0)} km/h">➜</div>`.replace('➜', '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3v15M6 12l6 7 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'), iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindPopup(popup('Wind', arrowC, `${fmtSpeed(p.wind)} from ${compass(p.windDir)}, gusts ${fmtSpeed(p.gust)}.`, src, p.time, demo)).addTo(this.groups.wind);
      cell(p, 'hail', p.hail6h ? 0.55 : 0, 'Hail possible', 'The model shows thunderstorms with hail within 6 hours. Hail size is not available from this provider.<br><b>Do:</b> park under cover and stay indoors during storms.', 'hail');
      const a = p.apparent;
      const hSev = a >= 54 ? 0.95 : a >= 46 ? 0.8 : a >= 41 ? 0.6 : a >= 38 ? 0.4 : a >= 32 ? 0.2 : 0;
      cell(p, 'heat', hSev, 'Heat stress', `Feels like ${fmtTemp(a)} (air ${fmtTemp(p.temp)}).<br><b>Do:</b> limit strenuous activity, drink water, find shade.`, 'heat');
    }
  }
  setAirGrid(grid, meta, { demo } = {}) {
    this.groups.air.clearLayers();
    if (!grid?.length) return;
    for (const p of grid) {
      if (p.usAqi == null) continue;
      const sev = p.usAqi >= 301 ? 0.88 : p.usAqi >= 201 ? 0.65 : p.usAqi >= 151 ? 0.45 : p.usAqi >= 101 ? 0.2 : 0.05;
      const c = cls(sev);
      L.rectangle([[p.lat - meta.step / 2, p.lon - meta.stepLon / 2], [p.lat + meta.step / 2, p.lon + meta.stepLon / 2]], { weight: 0, fillColor: cssVar('--' + c), fillOpacity: sev < 0.15 ? 0.06 : 0.15 + sev * 0.25 })
        .bindPopup(popup(`US AQI ${p.usAqi}`, c, `${aqiLabel(p.usAqi)}.${p.dust > 100 ? ` Dust ${Math.round(p.dust)} µg/m³.` : ''}`, demo ? 'DEMONSTRATION DATA' : 'Open-Meteo / CAMS model', Date.now(), demo)).addTo(this.groups.air);
    }
  }
  setRadar(frame) {
    if (this.radarLayer) { this.map.removeLayer(this.radarLayer); this.radarLayer = null; }
    if (!frame) return;
    this.radarLayer = L.tileLayer(`${frame.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.65, maxNativeZoom: 7, maxZoom: 19, zIndex: 300, attribution: `Radar: <a href="https://www.rainviewer.com/">RainViewer</a> (${new Date(frame.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` });
  }
  setFords(fords, { demo } = {}) {
    // Fords belong to the flood layer
    for (const f of fords || []) {
      L.marker([f.lat, f.lon], { icon: L.divIcon({ className: '', html: `<div class="m-glyph watch" title="Low-water crossing">${icon('flooded_road')}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindPopup(popup(f.name ? `Ford: ${esc(f.name)}` : 'Low-water crossing (ford)', 'watch', 'Mapped road or path that crosses water without a bridge. These flood quickly in heavy rain.<br><b>Do:</b> never cross when water is flowing over it.', demo ? 'DEMONSTRATION DATA' : 'OpenStreetMap', null, demo)).addTo(this.groups.flood);
    }
  }
  setWarnings(warnings) {
    this.groups.warnings.clearLayers();
    for (const w of warnings || []) {
      if (!w.geometry) continue;
      const c = w.severity === 'Extreme' ? 'emergency' : w.severity === 'Severe' ? 'warning' : w.severity === 'Moderate' ? 'watch' : 'safe';
      L.geoJSON(w.geometry, { style: { color: cssVar('--' + c), weight: 2, dashArray: '6 4', fillOpacity: 0.08 } })
        .bindPopup(popup(esc(w.event), c, `${esc(w.headline || '')}<br><small>Official severity: ${esc(w.severity)} · Until ${w.expires ? dateTime(Date.parse(w.expires)) : 'not stated'}</small>`, w.sourceName, w.fetchedAt, w.demo)).addTo(this.groups.warnings);
    }
  }
  setReports(reports, onOpen) {
    this.groups.community.clearLayers();
    for (const r of reports || []) {
      const verified = r.status === 'verified';
      const c = r.status === 'resolved' ? 'resolved' : verified ? 'verified' : 'unverified';
      L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', html: `<div class="m-report ${c}" aria-label="${esc(r.categoryLabel)}">${icon(r.category)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), title: r.categoryLabel })
        .on('click', () => onOpen?.(r)).addTo(this.groups.community);
    }
  }
  setResources(resources) {
    this.groups.resources.clearLayers();
    for (const r of resources || []) {
      L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', html: `<div class="m-res ${r.group}">${icon(r.type)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), title: r.name })
        .bindPopup(`<div class="pop"><div class="pop-h">${icon(r.type)} <b>${esc(r.name)}</b></div><div class="pop-b">${esc(r.label)}${r.note ? ` · ${esc(r.note)}` : ''}<br>${r.address ? esc(r.address) + '<br>' : ''}${r.phone ? `Phone: ${esc(r.phone)}<br>` : ''}${fmtDist(r.distance)} away</div><div class="pop-src">Mapped on OpenStreetMap · operating status unknown · <a href="https://www.openstreetmap.org/directions?route=;${r.lat},${r.lon}" target="_blank" rel="noopener">Directions</a></div></div>`)
        .addTo(this.groups.resources);
    }
  }
  setPick(latlng) {
    this.pickGroup.clearLayers();
    if (latlng) L.marker(latlng, { icon: L.divIcon({ className: '', html: `<div class="m-pick">${icon('pin')}</div>`, iconSize: [30, 30], iconAnchor: [15, 28] }) }).addTo(this.pickGroup);
  }
  setJourney(j, selectedId) {
    this.journeyGroup.clearLayers();
    if (!j) return;
    const bounds = [];
    [...j.routes].sort((a, b) => (a.id === selectedId) - (b.id === selectedId)).forEach((r) => {
      const sel = r.id === selectedId;
      const ll = r.coords.map((c) => [c.lat, c.lon]); bounds.push(...ll);
      L.polyline(ll, { color: sel ? cssVar('--' + r.rating.css) : cssVar('--muted'), weight: sel ? 6 : 4, opacity: sel ? 0.95 : 0.5, dashArray: sel ? null : '6 8' }).addTo(this.journeyGroup);
      if (sel) {
        r.hazards.filter((h) => h.lat != null && h.severity >= 0.25).forEach((h) => {
          L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', html: `<div class="m-glyph ${cls(h.severity)}">${icon(h.community ? 'reports' : h.label.includes('ford') ? 'flooded_road' : h.label.includes('wind') ? 'wind' : h.label.includes('Thunder') ? 'lightning' : h.label.includes('visibility') ? 'visibility' : h.label.includes('rain') ? 'flood' : 'warning')}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
            .bindPopup(popup(esc(h.label), cls(h.severity), `${esc(h.detail || '')}${h.eta ? `<br>Expected when you pass: around ${new Date(h.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`, j.demo ? 'DEMONSTRATION DATA' : h.community ? 'Community report' : h.source || 'Open-Meteo model / OpenStreetMap', j.computedAt, j.demo)).addTo(this.journeyGroup);
        });
      }
    });
    L.marker([j.to.lat, j.to.lon], { icon: L.divIcon({ className: '', html: `<div class="m-pick">${icon('pin')}</div>`, iconSize: [30, 30], iconAnchor: [15, 28] }) }).bindTooltip(esc(j.toLabel || 'Destination')).addTo(this.journeyGroup);
    if (bounds.length) this.map.fitBounds(bounds, { padding: [40, 40] });
  }
}

export function aqiLabel(a) {
  if (a == null) return 'No data';
  return a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Unhealthy for sensitive groups' : a <= 200 ? 'Unhealthy' : a <= 300 ? 'Very unhealthy' : 'Hazardous';
}

function popup(title, c, body, source, time, demo) {
  const label = { safe: 'Low', watch: 'Developing', warning: 'High', emergency: 'Severe', resolved: 'Resolved' }[c] || '';
  return `<div class="pop"><div class="pop-h"><span class="chip ${c}">${label}</span> <b>${title}</b></div><div class="pop-b">${body}</div><div class="pop-src">${demo ? '<span class="chip demo">DEMO</span> ' : ''}Source: ${esc(source)}${time ? ` · updated ${timeAgo(time)}` : ''}</div></div>`;
}
