// Unit tests for the quantity take-off (qto.js) and the .xlsx writer (xlsx.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQto, exactNumber, describeColumn, decimalsOf, unitOf, compileFormula, toCsv, toSheet, cellText, VARIES,
} from '../src/qto.js';
import { xlsx, crc32, columnName } from '../src/xlsx.js';
import { NONE } from '../src/filter.js';

// three walls and two floors; the text is rounded as Revit shows it, the numbers are exact
const wall = (id, type, vol, area, comments = 'A') => ({
  id, category: 'Walls', family: 'Basic Wall', type, level: 'Nula', volume_m3: vol,
  params: { Volume: `${vol.toFixed(2)} m³`, Area: `${Math.round(area)} m²`, Comments: comments },
  paramNumbers: { Volume: vol, Area: area },
  typeParams: { Width: '0.2000' }, typeParamNumbers: { Width: 0.2 },
});
const ds = [
  wall(1, 'Zid 20', 0.1049, 86.37),
  wall(2, 'Zid 20', 0.1251, 12.25, 'B'),
  wall(3, 'Zid 25', 1.5, 10.4),
  { id: 4, category: 'Floors', family: 'Floor', type: 'Ploča 20', level: 'Nula', volume_m3: 10, params: { Volume: '10.00 m³', Area: '50 m²' } },
  { id: 5, category: 'Floors', family: 'Floor', type: 'Ploča 20', level: 'Nula', volume_m3: 5, params: { Volume: '5.00 m³', Area: '25 m²' } },
];
const rowsOf = (t) => t.rows.map((r) => [r.kind, ...r.cells.map((v) => (v === VARIES ? 'varies' : v))]);

test("exactNumber: the exporter's exact value, else the number in the text; IDs and marks are text", () => {
  assert.equal(exactNumber(ds[0], 'Area'), 86.37);              // the text says "86 m²"
  assert.equal(exactNumber(ds[3], 'Area'), 50);                 // no exact value: the text
  assert.equal(exactNumber(ds[0], 'Width'), 0.2);               // a type parameter
  assert.equal(exactNumber(ds[0], 'Volume (m³)'), 0.1049);      // the volume field
  assert.ok(Number.isNaN(exactNumber(ds[0], 'Comments')));
  assert.ok(Number.isNaN(exactNumber({ id: 7, mark: '12', params: { Mark: '12' } }, 'Mark')));
  assert.ok(Number.isNaN(exactNumber(ds[0], 'Element ID')));
  // no usable exact value (null): the text
  assert.equal(exactNumber({ params: { L: '2.5' }, paramNumbers: { L: null } }, 'L'), 2.5);
});

test('decimals and units come from the display text', () => {
  assert.equal(decimalsOf('0.10 m³'), 2);
  assert.equal(decimalsOf('86 m²'), 0);
  assert.equal(decimalsOf('13.8000'), 4);
  assert.equal(decimalsOf('1.234,5 m'), 1);
  assert.equal(decimalsOf('1,5'), 1);
  assert.equal(decimalsOf('1.234.567'), 0);
  assert.equal(unitOf('171.60 m³'), 'm³');
  assert.equal(unitOf('1 234,5 cm³'), 'cm³');
  assert.equal(unitOf('0.1200'), '');
  assert.deepEqual(describeColumn(ds, 'Area'), { numeric: true, mixedUnits: false, unit: 'm²', places: 2 },
    'whole m² in the text, but the exact values are not whole: two decimals');
  assert.equal(describeColumn(ds, 'Volume').places, 2);
  assert.equal(describeColumn(ds, 'Comments').numeric, false);
  const mixed = [{ params: { V: '1.00 m³' } }, { params: { V: '500.00 cm³' } }];
  assert.deepEqual(describeColumn(mixed, 'V'), { numeric: false, mixedUnits: true, unit: '', places: 2 }, 'different units are not added up');
});

test('groups by category and type, totals the exact values, subtotals only for groups of several rows', () => {
  const t = buildQto(ds, { groupBy: ['Category', 'Type'], columns: [{ name: 'Volume' }, { name: 'Area' }, { name: 'Comments' }] });
  assert.deepEqual(t.head.map((h) => h.label), ['Category', 'Type', 'Count', 'Volume (m³)', 'Area (m²)', 'Comments']);
  assert.deepEqual(rowsOf(t), [
    ['group', 'Floors', 'Ploča 20', 2, 15, 75, null],
    ['group', 'Walls', 'Zid 20', 2, 0.23, 98.62, 'varies'],
    ['group', 'Walls', 'Zid 25', 1, 1.5, 10.4, 'A'],
    ['subtotal', 'Walls', 'Total', 3, 1.73, 109.02, 'varies'],
    ['total', 'Total', '', 5, 16.73, 184.02, 'varies'],
  ]);
  assert.equal(cellText(98.62, t.head[4], 'en'), '98.62');
  assert.equal(cellText(1234.5, t.head[3], 'de'), '1.234,50');
  assert.equal(cellText(5, t.head[2], 'en'), '5');
});

test('average, min and max; sorting by a column; no grouping is one total row', () => {
  const t = buildQto(ds, { groupBy: ['Category'], columns: [{ name: 'Area', agg: 'max' }, { name: 'Volume', agg: 'avg' }], sort: { by: 'c0', dir: -1 } });
  assert.deepEqual(rowsOf(t), [
    ['group', 'Walls', 3, 86.37, 0.576666666667],
    ['group', 'Floors', 2, 50, 7.5],
    ['total', 'Total', 5, 86.37, 3.346],
  ]);
  const up = buildQto(ds, { groupBy: ['Category'], columns: [{ name: 'Area' }], sort: { by: 'c0', dir: 1 } });
  assert.deepEqual(up.rows.map((r) => r.keys[0]), ['Floors', 'Walls', 'Total']);
  const flat = buildQto(ds, { groupBy: [], columns: [{ name: 'Area', agg: 'min' }] });
  assert.deepEqual(rowsOf(flat), [['total', 5, 10.4]]);
});

test('one row per element, with its ID, under subtotals; (none) groups last', () => {
  const more = [...ds, { id: 6, category: 'Walls', type: '', params: {} }];
  const t = buildQto(more, { groupBy: ['Category'], columns: [{ name: 'Volume' }], itemize: true });
  assert.deepEqual(t.head.map((h) => h.label), ['Category', 'Element ID', 'Count', 'Volume (m³)']);
  assert.deepEqual(rowsOf(t), [
    ['item', 'Floors', '4', 1, 10], ['item', 'Floors', '5', 1, 5], ['subtotal', 'Floors', 'Total', 2, 15],
    ['item', 'Walls', '1', 1, 0.1049], ['item', 'Walls', '2', 1, 0.1251], ['item', 'Walls', '3', 1, 1.5], ['item', 'Walls', '6', 1, null],
    ['subtotal', 'Walls', 'Total', 4, 1.73],
    ['total', 'Total', '', 6, 16.73],
  ]);
  const byType = buildQto(more, { groupBy: ['Type'], columns: [] });
  assert.deepEqual(byType.rows.map((r) => r.keys[0]), ['Ploča 20', 'Zid 20', 'Zid 25', NONE, 'Total']);
});

test('formulas: precedence, brackets, decimal commas, missing values, readable errors', () => {
  const f = compileFormula('([Volume] + 2) * 2,5 - -1 / 4');
  assert.deepEqual(f.refs, ['Volume']);
  assert.equal(f.evaluate(() => 2), 10.25);
  assert.ok(Number.isNaN(f.evaluate(() => NaN)), 'a missing value gives no value');
  assert.ok(Number.isNaN(compileFormula('[A] / [B]').evaluate((n) => (n === 'A' ? 1 : 0))), 'division by zero gives no value');
  assert.equal(compileFormula('[Area] × 2').evaluate(() => 3), 6);
  for (const bad of ['', '[Area', '[Area] *', '(1 + 2', '1 + ] 2', '[Area] ^ 2', '[ ] + 1']) {
    assert.throws(() => compileFormula(bad), Error, `"${bad}"`);
  }
  const t = buildQto(ds, {
    groupBy: ['Category'],
    columns: [{ name: 'Concrete (kg)', formula: '[Volume] * 2400' }, { name: 'Bad', formula: '[Volume] *' }],
  });
  assert.equal(t.head[2].label, 'Concrete (kg)');
  assert.match(t.head[3].error, /ends too early/);
  assert.deepEqual(rowsOf(t).map((r) => r.slice(0, 4)), [['group', 'Floors', 2, 36000], ['group', 'Walls', 3, 4152], ['total', 'Total', 5, 40152]]);
});

test("CSV opens in Excel in the reader's region: ';' and decimal commas where the comma is the decimal", () => {
  const t = buildQto(ds.slice(0, 2), { groupBy: ['Type'], columns: [{ name: 'Area' }, { name: 'Comments' }] });
  const de = toCsv(t, 'de');
  assert.ok(de.startsWith('﻿'), 'a BOM, so Excel reads UTF-8');
  assert.deepEqual(de.slice(1).trim().split('\r\n'), ['Type;Count;Area (m²);Comments', 'Zid 20;2;98,62;', 'Total;2;98,62;']);
  const en = toCsv(buildQto([{ id: 1, type: 'A, "B"', params: { L: '1234.5' } }], { groupBy: ['Type'], columns: [{ name: 'L' }] }), 'en');
  assert.deepEqual(en.slice(1).trim().split('\r\n'), ['Type,Count,L', '"A, ""B""",1,1234.5', 'Total,1,1234.5']);
});

/** The files of a zip whose entries are stored: name -> text. Checks every CRC. */
export function unzipStored(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    assert.equal(v.getUint16(at + 8, true), 0, 'stored');
    const crc = v.getUint32(at + 14, true), size = v.getUint32(at + 18, true), nameLen = v.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out[name] = new TextDecoder().decode(data);
    at += 30 + nameLen + size;
  }
  assert.equal(v.getUint32(bytes.length - 22, true), 0x06054b50, 'end of the central directory');
  assert.equal(v.getUint16(bytes.length - 22 + 10, true), Object.keys(out).length);
  return out;
}

test("xlsx: a valid zip of the workbook parts; numbers stay numbers with the column's decimals", () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  const t = buildQto(ds, { groupBy: ['Category', 'Type'], columns: [{ name: 'Volume' }, { name: 'Comments' }] });
  const sheet = toSheet(t, 'Quantities – Most <A&B>', [['Model', 'Most'], ['Elements', 'All 5']]);
  assert.equal(sheet.freeze, 5, 'the title, two lines, a blank line and the header stay in view');
  const files = unzipStored(xlsx({ name: 'Quantities', ...sheet }));
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const ws = files['xl/worksheets/sheet1.xml'];
  assert.match(ws, /<c r="A1" s="1" t="inlineStr"><is><t>Quantities – Most &lt;A&amp;B&gt;<\/t><\/is><\/c>/);
  assert.match(ws, /<pane ySplit="5" topLeftCell="A6"/);
  assert.match(ws, /<row r="5"><c r="A5" s="3" t="inlineStr"><is><t>Category<\/t>/);
  // Walls / Zid 20: count 2 (whole numbers), volume 0.23 (two decimals); the comments vary: empty
  const row7 = ws.match(/<row r="7">(.*?)<\/row>/)[1];
  assert.match(row7, /<c r="C7" s="6"><v>2<\/v><\/c><c r="D7" s="8"><v>0.23<\/v><\/c>$/);
  assert.match(ws, /<c r="A10" s="5" t="inlineStr"><is><t>Total<\/t>/, 'the total row is bold');
  assert.match(files['xl/workbook.xml'], /<sheet name="Quantities" sheetId="1" r:id="rId1"\/>/);
  for (const [name, text] of Object.entries(files)) assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text), `${name}: no control characters`);
});
