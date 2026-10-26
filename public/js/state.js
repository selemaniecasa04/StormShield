// Minimal observable application state. Every module reads and writes through here
// so location, hazards, score, layers and alerts stay consistent across sections.
import { store } from './util.js';

const listeners = new Set();

export const state = {
  section: 'overview',
  // Location
  location: null,            // { lat, lon, accuracy, heading, speed, at, label }
  locationMode: 'none',      // 'following' | 'fixed' | 'manual' | 'none'
  locationStatus: 'idle',    // 'idle' | 'requesting' | 'ok' | 'denied' | 'unavailable' | 'timeout' | 'unsupported'
  placeName: null,
  // Data, one entry per source: { status: 'loading'|'ok'|'error'|'unavailable'|'not_applicable', data, error, updatedAt, demo }
  sources: {},
  conditions: null,          // normalised environmental picture used by the risk engine
  assessment: null,          // output of risk.assess()
  previousAssessment: null,
  history: [],               // score change log
  alertsLog: [],             // notifications raised this session
  journey: null,
  resources: null,
  reports: [],
  // Preferences (persisted)
  prefs: {
    theme: store.get('theme', 'system'),
    units: store.get('units', 'metric'),
    activity: store.get('activity', 'auto'),
    notify: store.get('notify', false),
    notifyMin: store.get('notifyMin', 'WARNING'),
    follow: store.get('follow', true),
    preciseReports: store.get('preciseReports', true),
    layers: store.get('layers', { radar: true, storms: true, flood: true, wind: false, hail: true, heat: false, air: false, community: true, resources: true, warnings: true }),
  },
  demo: { active: false, scenario: null },
};

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
}

export function setSource(name, value) {
  state.sources = { ...state.sources, [name]: { ...(state.sources[name] || {}), ...value } };
  listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
}

export function setPref(key, value) {
  state.prefs = { ...state.prefs, [key]: value };
  store.set(key, value);
  setState({});
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
