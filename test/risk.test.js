// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../public/js/risk.js';
import { buildDemo } from '../public/js/demo.js';

const centre = { lat: -29.85, lon: 31.02 };
const run = (key, extra = {}) => {
  const d = buildDemo(key, centre);
  return assess({ ...d, location: centre, warningsCoverage: 'connected', demo: true, ...extra }, { activityPref: 'auto' });
};

test('calm conditions are SAFE with a high score', () => {
  const a = run('calm', { warnings: [] });
  assert.equal(a.level, 'SAFE');
  assert.ok(a.score >= 75, `score ${a.score}`);
});

test('one severe hazard cannot be averaged away', () => {
  const d = buildDemo('calm', centre);
  d.weather.current.gust = 120; // everything else calm
  const a = assess({ ...d, warnings: [], location: centre, warningsCoverage: 'connected' }, {});
  assert.equal(a.hazards[0].id, 'wind');
  assert.equal(a.level, 'EMERGENCY');
});

test('extreme official warning forces EMERGENCY and keeps original severity', () => {
  const a = run('flood');
  assert.equal(a.level, 'EMERGENCY');
  const o = a.hazards.find((h) => h.official);
  assert.equal(o.official.severity, 'Extreme');
});

test('missing weather gives UNKNOWN, not SAFE', () => {
  const a = assess({ weather: null, location: centre }, {});
  assert.equal(a.level, 'UNKNOWN');
  assert.equal(a.score, null);
});

test('indoor activity lowers exposure to heat', () => {
  const d = buildDemo('heat', centre);
  const base = { ...d, warnings: [], location: centre, warningsCoverage: 'connected' };
  const out = assess(base, { activityPref: 'outdoors' });
  const ind = assess(base, { activityPref: 'indoors' });
  assert.ok(out.score < ind.score, `${out.score} < ${ind.score}`);
});

test('no official feed reduces confidence', () => {
  const d = buildDemo('calm', centre);
  const a = assess({ ...d, warnings: [], location: centre, warningsCoverage: 'none' }, {});
  assert.equal(a.confidence, 'medium');
});
