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
