// Unit tests for the viewer's pure logic: filter rules, number parsing, explode offsets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber, testRule, matches, emptyFilter, filterActive, searchText, ruleComplete, facetValues, FACETS, NONE,
} from '../src/filter.js';
import { explodeOffsets } from '../src/explode.js';

const wall = {
  id: 843064, category: 'Walls', family: 'Basic Wall', type: 'Obloga od Kulira', level: 'Nula',
  mark: null, comments: null, volume_m3: 8.5254, materials: ['Kulir'], uniqueId: 'b1ff-000cdd38',
  params: { Volume: '8.53 m³', Area: '171 m²', Length: '13.8000', 'Base Offset': '25.0280', Faktor: '1,5', Dilatacija: 'Novi most', Empty: '' },
  typeParams: { Width: '0.0500', Function: 'Exterior' },
};
const floor = {
  id: 452339, category: 'Floors', family: 'Floor', type: 'Montažne ploče d=12cm', level: 'GKT_24.2980',
  mark: 'P-1', comments: 'Provjeriti – šđčćž', volume_m3: 2.5, materials: ['Beton C25/30', 'Hidroizolacija'],
  params: { Volume: '2.50 m³', Area: '20 m²', Faktor: '2,0', Dilatacija: 'Stari most' },
  typeParams: { Width: '0.1200', Function: 'Interior' },
};
const rule = (name, op, value = '') => ({ name, op, value });

test('parseNumber reads the leading number of display strings', () => {
  const cases = {
    '8.53 m³': 8.53, '171 m²': 171, '25.0280': 25.028, '1,5': 1.5, '-3 mm': -3, '−2.5': -2.5,
    '1.234,5 kg': 1234.5, '1,234.5': 1234.5, '1.234.567': 1234567, '.5': 0.5, ',25': 0.25, '8.': 8,
    '0.0500': 0.05, 'Interior <20 mm>': NaN, '': NaN, 'abc': NaN,
  };
  for (const [s, v] of Object.entries(cases)) {
    if (Number.isNaN(v)) assert.ok(Number.isNaN(parseNumber(s)), s);
    else assert.equal(parseNumber(s), v, s);
  }
  assert.equal(parseNumber(12), 12);
  assert.ok(Number.isNaN(parseNumber(null)));
});

test('every operator', () => {
  const t = (r, d = wall) => testRule(d, r);
  // equals / does not equal: case-insensitive, numbers equal across units and comma decimals
  assert.ok(t(rule('Dilatacija', 'eq', 'novi MOST')));
  assert.ok(t(rule('Volume', 'eq', '8.53')));
  assert.ok(t(rule('Volume', 'eq', '8,53')));
  assert.ok(t(rule('Faktor', 'eq', '1.5')));
  assert.ok(!t(rule('Volume', 'eq', '8.5')));
  assert.ok(t(rule('Dilatacija', 'ne', 'Stari most')));
  assert.ok(!t(rule('Dilatacija', 'ne', 'Novi most')));
  assert.ok(t(rule('Missing', 'ne', 'x')), 'no value does not equal x');
  // contains / does not contain / begins with
  assert.ok(t(rule('Type', 'contains', 'kulir')));
  assert.ok(!t(rule('Type', 'ncontains', 'Kulir')));
  assert.ok(t(rule('Type', 'ncontains', 'beton')));
  assert.ok(t(rule('Type', 'begins', 'obloga')));
  assert.ok(!t(rule('Type', 'begins', 'Kulir')));
  // numeric: leading number of "8.53 m³", "1,5"
  assert.ok(t(rule('Volume', 'gt', '8')));
  assert.ok(!t(rule('Volume', 'gt', '8.53')));
  assert.ok(t(rule('Volume', 'ge', '8.53')));
  assert.ok(t(rule('Volume', 'lt', '9')));
  assert.ok(t(rule('Volume', 'le', '8,53')));
  assert.ok(t(rule('Faktor', 'gt', '1,25')));
  assert.ok(t(rule('Faktor', 'lt', '2')));
  assert.ok(!t(rule('Dilatacija', 'gt', '0')), 'text is never greater than a number');
  // has value / has no value (empty strings count as no value)
  assert.ok(t(rule('Area', 'has')));
  assert.ok(t(rule('Empty', 'hasnot')));
  assert.ok(t(rule('Missing', 'hasnot')));
  assert.ok(!t(rule('Area', 'hasnot')));
  // type parameters and built-in fields
  assert.ok(t(rule('Width', 'lt', '0.1')));
  assert.ok(t(rule('Level', 'eq', 'Nula')));
  assert.ok(t(rule('Element ID', 'eq', '843064')));
  assert.ok(t(rule('Volume (m³)', 'gt', '8.5')));
});

test('multi-valued material: any value matches, negatives mean none matches', () => {
  assert.ok(testRule(floor, rule('Material', 'eq', 'hidroizolacija')));
  assert.ok(testRule(floor, rule('Material', 'contains', 'beton')));
  assert.ok(!testRule(floor, rule('Material', 'ncontains', 'beton')));
  assert.ok(testRule(wall, rule('Material', 'ncontains', 'beton')));
});

test('incomplete rules are ignored', () => {
  assert.ok(!ruleComplete(rule('', 'eq', 'x')));
  assert.ok(!ruleComplete(rule('Volume', 'gt', '  ')));
  assert.ok(ruleComplete(rule('Volume', 'has')));
  const s = emptyFilter();
  s.rules.push(rule('Volume', 'gt', ''));
  assert.ok(!filterActive(s));
  assert.ok(matches({ d: floor }, s));
});

test('rules combine with AND or OR; facets and search narrow further', () => {
  const els = [wall, floor].map((d) => ({ d, text: searchText(d) }));
  const ids = (s) => els.filter((e) => matches(e, s)).map((e) => e.d.id);
  const s = emptyFilter();
  assert.deepEqual(ids(s), [843064, 452339]);
  s.rules = [rule('Volume', 'gt', '5'), rule('Dilatacija', 'eq', 'Stari most')];
  assert.deepEqual(ids(s), []);
  s.combine = 'or';
  assert.deepEqual(ids(s), [843064, 452339]);
  s.rules = [];
  s.excluded.category = new Set(['Walls']);
  assert.ok(filterActive(s));
  assert.deepEqual(ids(s), [452339]);
  s.excluded.category = new Set();
  s.excluded.material = new Set(['Beton C25/30']);   // floor still has Hidroizolacija
  assert.deepEqual(ids(s), [843064, 452339]);
  s.excluded.material = new Set(['Beton C25/30', 'Hidroizolacija']);
  assert.deepEqual(ids(s), [843064]);
  s.excluded.material = new Set();
  s.search = 'šđčćž';
  assert.deepEqual(ids(s), [452339]);
  s.search = '843064';
  assert.deepEqual(ids(s), [843064]);
  s.search = 'kulir 171';   // every word must be found
  assert.deepEqual(ids(s), [843064]);
  s.search = 'kulir stari';
  assert.deepEqual(ids(s), []);
});

test('facet values show missing values as (none)', () => {
  const level = FACETS.find((f) => f.key === 'level');
  assert.deepEqual(facetValues({ ...wall, level: null }, level), [NONE]);
  const material = FACETS.find((f) => f.key === 'material');
  assert.deepEqual(facetValues(floor, material), ['Beton C25/30', 'Hidroizolacija']);
  assert.deepEqual(facetValues({ ...wall, materials: [] }, material), [NONE]);
});

test('explode offsets', () => {
  const items = [
    { center: [-10, 0, 0], category: 'Floors', shown: true },
    { center: [10, 0, 0], category: 'Floors', shown: true },
    { center: [0, 8, 0], category: 'Roofs', shown: true },
    { center: [0, 4, 0], category: 'Walls', shown: true },
    { center: [50, 50, 50], category: 'Walls', shown: false },
  ];
  // nothing moves at 0 %, hidden items never move
  for (const mode of ['centre', 'vertical', 'category']) {
    assert.deepEqual(explodeOffsets(items, mode, 0, 20), items.map(() => [0, 0, 0]));
    assert.deepEqual(explodeOffsets(items, mode, 1, 20)[4], [0, 0, 0]);
  }
  // from centre: centre of shown centres is (0, 4, 0); the farthest moves the full radius
  const c = explodeOffsets(items, 'centre', 1, 20);
  const far = Math.max(...c.map((o) => Math.hypot(...o)));
  assert.ok(Math.abs(far - 20) < 1e-9);
  assert.ok(c[0][0] < 0 && c[1][0] > 0, 'moves away from the centre');
  assert.deepEqual(c[3], [0, 0, 0], 'the element at the centre stays');
  // vertical: Y only, proportional to height
  const v = explodeOffsets(items, 'vertical', 0.5, 20);
  assert.deepEqual(v.map((o) => o[1]), [0, 0, 10, 5, 0]);
  assert.ok(v.every((o) => o[0] === 0 && o[2] === 0));
  // by category: ordered by average height Floors < Walls < Roofs
  const k = explodeOffsets(items, 'category', 1, 20);
  assert.deepEqual(k.map((o) => o[1]), [0, 0, 20, 10, 0]);
});

// ---------- colour by parameter ----------
import { colourScheme, valueKey, numberOf, formatBound, SLOTS, BINS, OTHER, NOT_A_NUMBER } from '../src/colour.js';

const tones = (s) => s.entries.map((e) => e.tone);
const labels = (s) => s.entries.map((e) => e.label);

test('valueKey: arrays joined, empty and missing are (none)', () => {
  assert.equal(valueKey('  Nula '), 'Nula');
  assert.equal(valueKey(8.53), '8.53');
  assert.equal(valueKey(null), NONE);
  assert.equal(valueKey(''), NONE);
  assert.equal(valueKey(['Kulir', '', 'Beton']), 'Kulir, Beton');
  assert.equal(valueKey([]), NONE);
});

test('values: one colour per value in natural order, (none) last and grey', () => {
  const s = colourScheme(['Zid', 'Ploča', 'Zid', null, 'Krov', 'Zid', '']);
  assert.equal(s.kind, 'values');
  assert.deepEqual(labels(s), ['Krov', 'Ploča', 'Zid', NONE]);
  assert.deepEqual(tones(s), ['s1', 's2', 's3', 'none']);
  assert.deepEqual(s.entries.map((e) => e.count), [1, 1, 3, 2]);
  assert.equal(s.entries[s.entryOf('Zid')].tone, 's3');
  assert.equal(s.entries[s.entryOf(NONE)].label, NONE);
  assert.equal(s.canRange, false);
});

test(`values: the ${SLOTS} most common get colours, the rest fold into Other`, () => {
  // v1 x10, v2 x9 ... v12 x1 (a numbered name, so natural order is v1, v2 ... v10)
  const items = [];
  for (let i = 1; i <= 12; i++) for (let k = 0; k <= 12 - i; k++) items.push(`v${i}`);
  const s = colourScheme(items, 'values');
  assert.equal(s.entries.length, SLOTS + 1);
  assert.deepEqual(labels(s).slice(0, SLOTS), ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']);
  assert.deepEqual(tones(s), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'other']);
  const other = s.entries.at(-1);
  assert.equal(other.label, OTHER);
  assert.deepEqual(other.keys.map((k) => k.label), ['v9', 'v10', 'v11', 'v12']);
  assert.equal(other.count, 4 + 3 + 2 + 1);
  assert.equal(s.entries[s.entryOf('v11')].tone, 'other');
  // the colours follow the values, not the order they came in
  const again = colourScheme([...items].reverse(), 'values');
  assert.deepEqual(again.entries.map((e) => [e.label, e.tone]), s.entries.map((e) => [e.label, e.tone]));
});

test('several values per element (materials) count each element once', () => {
  const s = colourScheme([['Beton', 'Keramika'], ['Beton'], ['Kulir'], []]);
  assert.deepEqual(labels(s), ['Beton', 'Keramika', 'Kulir', NONE]);
  assert.deepEqual(s.entries.map((e) => e.count), [2, 1, 1, 1]);
});

test('numberOf: numbers with units are numbers; codes and sizes are text', () => {
  for (const [v, n] of [['8.53 m³', 8.53], ['1,5', 1.5], ['-3', -3], ['25.0280', 25.028], ['1 234,5 kN', 1234.5],
    ['1,234.5', 1234.5], ['30 %', 30], ['.5', 0.5], ['841.641 m³', 841.641], ['13.8000', 13.8]]) {
    assert.equal(numberOf(v), n, v);
  }
  for (const v of ['5.1.3', '25 x 40', '400 x 800mm', 'HEB 300', 'M-7', '2.2a1', '']) assert.ok(Number.isNaN(numberOf(v)), v);
});

test('range: one big element does not squeeze everything into one step', () => {
  // 140 small volumes and two huge ones, like a bridge with abutments
  const items = [...Array.from({ length: 140 }, (_, i) => `${(0.5 + i * 0.25).toFixed(2)} m³`), '600 m³', '841.641 m³'];
  const s = colourScheme(items, 'range', 'en-US');
  assert.equal(s.entries.length, BINS);
  for (const e of s.entries) assert.ok(e.count >= 30 && e.count <= 40, `${e.label}: ${e.count}`);
  assert.equal(s.entries.at(-1).hi, 841.641);
  assert.equal(s.entries[s.entryOf('841.641 m³')].tone, 'q4');
});

test('range: few different numbers give fewer steps, still light to dark', () => {
  const s = colourScheme(['1', '1', '1', '1', '1', '1', '2', '2'], 'range', 'en-US');
  assert.deepEqual(labels(s), ['1', '2']);
  assert.deepEqual(tones(s), ['q1', 'q4']);
  assert.deepEqual(s.entries.map((e) => e.count), [6, 2]);
});

test('BOQ positions such as 5.1.3 are codes: shown as values, not a range', () => {
  const items = ['2.2', '2.2', '5.1.3', '5.1.4', '2.10', '3.1', '3.2', '4.1', '4.2', '4.3', '6.1.1'];
  const s = colourScheme(items);
  assert.equal(s.kind, 'values');
  assert.ok(labels(s).includes('5.1.3'));
});

test(`range: numbers in up to ${BINS} steps, with the unit and decimal commas`, () => {
  const items = ['0 m³', '2,5 m³', '5 m³', '7.5 m³', '10 m³', '10 m³', '1 m³', '3 m³', '6 m³', null];
  const s = colourScheme(items, 'range', 'en-US');
  assert.equal(s.kind, 'range');
  assert.deepEqual(labels(s), ['0 – 1 m³', '2.5 – 3 m³', '5 – 6 m³', '7.5 – 10 m³', NONE]);
  assert.deepEqual(tones(s), ['q1', 'q2', 'q3', 'q4', 'none']);
  // lower bound included; the largest value goes in the last step
  assert.deepEqual(s.entries.map((e) => e.count), [2, 2, 2, 3, 1]);
  assert.equal(s.entries[s.entryOf('2,5 m³')].tone, 'q2');
  assert.equal(s.entries[s.entryOf('10 m³')].tone, 'q4');
});

test('auto: numbers with many values are a range; few values, codes or text stay values', () => {
  const many = Array.from({ length: 20 }, (_, i) => `${(i * 0.37).toFixed(2)} m`);
  assert.equal(colourScheme(many).kind, 'range');
  assert.equal(colourScheme(['2.1', '2.2', '2.10', '3']).kind, 'values');      // BOQ positions
  assert.equal(colourScheme(['2.1', '2.2', '2.10', '3']).canRange, true);
  assert.equal(colourScheme([...many, 'n/a']).kind, 'values');                  // not all numbers
  const forced = colourScheme([...many, 'n/a'], 'range', 'en-US');
  assert.equal(forced.kind, 'range');
  assert.equal(forced.entries.at(-1).label, NOT_A_NUMBER);
  assert.equal(forced.entries.at(-1).tone, 'other');
  // a range needs two different numbers
  assert.equal(colourScheme(['5', '5', 'x'], 'range').kind, 'values');
});

test('range labels keep enough decimals to tell steps apart', () => {
  assert.equal(formatBound(0.123456, 0.01, 'en-US'), '0.123');
  assert.equal(formatBound(1234.5, 300, 'en-US'), '1,235');
  assert.equal(formatBound(2.5, 2.5, 'en-US'), '2.5');
});

// ---------- cuts and measuring ----------
import { Vector3, Plane } from 'three';
import { toRevit, axisParam, snapNormal, nearestWithin, keptBy, metres } from '../src/geom.js';

test('toRevit undoes the exporter axes: (x, z, -y) recentred', () => {
  assert.deepEqual(toRevit(new Vector3(1, 2, 3), [100, 200, 10]), [101, 197, 12]);
  assert.deepEqual(toRevit(new Vector3(0, 0, 0)).map((v) => v + 0), [0, 0, 0]);
});

test('axisParam: where along a handle axis the pointer ray passes closest', () => {
  const X = new Vector3(1, 0, 0);
  // a ray straight down through x = 5 crosses the X axis at t = 5
  assert.equal(axisParam(new Vector3(0, 0, 0), X, new Vector3(5, 10, 0), new Vector3(0, -1, 0)), 5);
  // the axis starting elsewhere: t is measured from its own origin
  assert.equal(axisParam(new Vector3(2, 0, 0), X, new Vector3(5, 10, 3), new Vector3(0, -1, 0)), 3);
  // a slanted ray
  const t = axisParam(new Vector3(0, 0, 0), X, new Vector3(0, 4, 0), new Vector3(1, -1, 0).normalize());
  assert.ok(Math.abs(t - 4) < 1e-9, String(t));
  // looking along the axis: no answer
  assert.equal(axisParam(new Vector3(0, 0, 0), X, new Vector3(-5, 0, 0), X), null);
});

test('snapNormal: nearly square faces become square; slopes stay', () => {
  assert.deepEqual(snapNormal(new Vector3(0.03, 0.999, 0)).toArray(), [0, 1, 0]);
  assert.deepEqual(snapNormal(new Vector3(0, 0, -1)).toArray(), [0, 0, -1]);
  const roof = snapNormal(new Vector3(0, 0.9, 0.3));   // about 18° slope
  assert.ok(Math.abs(roof.length() - 1) < 1e-12 && roof.z > 0.3);
});

test('nearestWithin picks the closest point inside the radius', () => {
  assert.equal(nearestWithin([[0, 0], [10, 0], null, [3, 4]], [2, 3], 12), 3);
  assert.equal(nearestWithin([[50, 50]], [0, 0], 12), -1);
});

test('keptBy: three.js keeps the side the plane normal points to', () => {
  const keepAboveZero = new Plane(new Vector3(0, 1, 0), 0);
  const keepBelowTwo = new Plane(new Vector3(0, -1, 0), 2);
  assert.equal(keptBy([keepAboveZero, keepBelowTwo], new Vector3(0, 1, 0)), true);
  assert.equal(keptBy([keepAboveZero, keepBelowTwo], new Vector3(0, 3, 0)), false);
  assert.equal(keptBy([keepAboveZero], new Vector3(0, -0.5, 0)), false);
  assert.equal(keptBy([], new Vector3(9, 9, 9)), true);
});

test('metres: three decimals', () => {
  assert.equal(metres(10, 'en-US'), '10.000');
  assert.equal(metres(1234.5678, 'en-US'), '1,234.568');
});

test('toShared: survey coordinates from the exporter map, rotation included', async () => {
  const { toShared } = await import('../src/geom.js');
  const flat = { origin: [6601541.966, 4699562.621, 0], basisX: [1, 0, 0], basisY: [0, 1, 0], basisZ: [0, 0, 1] };
  assert.deepEqual(toShared([-9.138, -5.761, 30.214], flat).map((v) => Number(v.toFixed(3))), [6601532.828, 4699556.86, 30.214]);
  // project north turned 90° from true north: internal +X is shared +Y
  const turned = { origin: [100, 200, 5], basisX: [0, 1, 0], basisY: [-1, 0, 0], basisZ: [0, 0, 1] };
  assert.deepEqual(toShared([10, 0, 1], turned), [100, 210, 6]);
  assert.deepEqual(toShared([0, 10, 0], turned), [90, 200, 5]);
  assert.equal(toShared([1, 2, 3], undefined), null);
});
