// Quantity take-off: pure logic, testable in Node. Groups elements by parameters
// (Category, Type ...) and totals the number parameters of each group, like a Revit
// schedule. Totals use the exporter's exact values (paramNumbers / typeParamNumbers):
// Revit's display text is rounded ("86 m²"), so summing it would drift from Revit.
import { fieldValue, NONE } from './filter.js';
import { valueKey, numberOf } from './colour.js';

export const COUNT = 'Count';
export const ELEMENT_ID = 'Element ID';
export const AGGREGATES = [
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
  { id: 'min', label: 'Min' },
  { id: 'max', label: 'Max' },
];
/** A text column whose elements have different values. */
export const VARIES = Object.freeze({ varies: true });
/** Identifiers, never added up even when they look like numbers. */
const TEXT_FIELDS = new Set([ELEMENT_ID, 'Unique ID', 'Mark', 'Type Mark', 'Type Id']);

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
/** Natural order with "(none)" last. */
const byKey = (a, b) => (a === NONE) - (b === NONE) || natural(a, b);
// a number as Revit writes one, with digit grouping: the unit is what follows it
// ("13.8000" is not 13 800 and a 0: a group is exactly three digits)
const LEADING_NUMBER = /^\s*[-+−]?(?:\d{1,3}(?:[,. ' ]\d{3})+(?!\d)(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)/;

export const unitOf = (text) => text.replace(LEADING_NUMBER, '').trim();

/** Decimals written in a display value: "0.10 m³" -> 2, "86 m²" -> 0, "1.234,5" -> 1. */
export function decimalsOf(text) {
  const m = String(text).match(LEADING_NUMBER);
  if (!m) return 0;
  const t = m[0].trim();
  const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  if (last < 0) return 0;
  const sep = t[last];
  const other = sep === '.' ? ',' : '.';
  // one kind of separator written more than once groups thousands ("1.234.567")
  if (!t.includes(other) && t.split(sep).length > 2) return 0;
  return t.length - last - 1;
}

/**
 * The exact number of a parameter on an element: the exporter's unrounded value when the
 * file has one, else the number in the display text. NaN when it is not a number.
 */
export function exactNumber(d, name) {
  if (TEXT_FIELDS.has(name)) return NaN;
  if (own(d.params, name)) return pick(d.paramNumbers, name, d.params[name]);
  if (own(d.typeParams, name)) return pick(d.typeParamNumbers, name, d.typeParams[name]);
  if (name === 'Volume (m³)') return typeof d.volume_m3 === 'number' ? d.volume_m3 : NaN;
  const v = fieldValue(d, name);
  return Array.isArray(v) ? NaN : numberOf(valueKey(v));
}
function pick(numbers, name, text) {
  const n = own(numbers, name) ? numbers[name] : null;
  return typeof n === 'number' && Number.isFinite(n) ? n : numberOf(valueKey(text));
}

/**
 * What a column holds over these elements: numbers with one unit (added up), or text.
 * places: decimals to show, as the display text has them; 2 when the text is rounded to
 * whole numbers but the exact values are not ("86 m²" is 86.37).
 */
export function describeColumn(ds, name) {
  let numbers = 0, texts = 0, decimals = 0, fractional = false;
  const units = new Set();
  for (const d of ds) {
    const key = valueKey(fieldValue(d, name));
    if (key === NONE) continue;
    const n = exactNumber(d, name);
    if (!Number.isFinite(n)) { texts++; continue; }
    numbers++;
    units.add(unitOf(key));
    decimals = Math.max(decimals, decimalsOf(key));
    if (Math.abs(n - Math.round(n)) > 1e-9 * Math.max(1, Math.abs(n))) fractional = true;
  }
  const numeric = numbers > 0 && texts === 0 && units.size <= 1;
  return {
    numeric,
    mixedUnits: units.size > 1,
    unit: numeric ? [...units][0] ?? '' : '',
    places: Math.min(6, decimals > 0 ? decimals : fractional ? 2 : 0),
  };
}

/**
 * A formula column: numbers, [Parameter] names, + - * / and brackets, e.g.
 * "[Volume] * 2400" or "([Area] - 2,5) / 2" (a decimal comma is fine). Returns
 * { refs, evaluate(get) } where get(name) gives a number; the result is NaN when a value
 * is missing. Throws an Error with a readable message for a wrong formula.
 */
export function compileFormula(text) {
  const src = String(text ?? '');
  const tokens = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) throw new Error('A [ has no closing ]');
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new Error('Empty [ ] in the formula');
      tokens.push({ t: 'ref', v: name });
      i = j + 1;
      continue;
    }
    const num = src.slice(i).match(/^(?:\d+(?:[.,]\d+)?|[.,]\d+)/);
    if (num) { tokens.push({ t: 'num', v: parseFloat(num[0].replace(',', '.')) }); i += num[0].length; continue; }
    if ('+-*/()×−'.includes(c)) { tokens.push({ t: 'op', v: c === '×' ? '*' : c === '−' ? '-' : c }); i++; continue; }
    throw new Error(`Unexpected "${c}" in the formula; use [Parameter] names, numbers and + - * / ( )`);
  }
  if (!tokens.length) throw new Error('The formula is empty');
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const refs = new Set();
  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := '-' factor | num | ref | '(' expr ')'
  function expr() {
    let f = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[at++].v, a = f, b = term();
      f = op === '+' ? (g) => a(g) + b(g) : (g) => a(g) - b(g);
    }
    return f;
  }
  function term() {
    let f = factor();
    while (isOp('*') || isOp('/')) {
      const op = tokens[at++].v, a = f, b = factor();
      f = op === '*' ? (g) => a(g) * b(g) : (g) => a(g) / b(g);
    }
    return f;
  }
  function factor() {
    const tk = tokens[at++];
    if (!tk) throw new Error('The formula ends too early');
    if (tk.t === 'op' && tk.v === '-') { const f = factor(); return (g) => -f(g); }
    if (tk.t === 'op' && tk.v === '+') return factor();
    if (tk.t === 'num') return () => tk.v;
    if (tk.t === 'ref') { refs.add(tk.v); return (g) => g(tk.v); }
    if (tk.t === 'op' && tk.v === '(') {
      const f = expr();
      if (!isOp(')')) throw new Error('A ( has no closing )');
      at++;
      return f;
    }
    throw new Error(`Unexpected "${tk.v}" in the formula`);
  }
  const f = expr();
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at].v}" in the formula`);
  return {
    refs: [...refs],
    evaluate: (get) => { const v = f(get); return Number.isFinite(v) ? v : NaN; },
  };
}

/** 12 significant digits: no 0.22999999999999998 from adding 0.1049 and 0.1251. */
const tidy = (v) => (v === 0 ? 0 : Number(v.toPrecision(12)));

function aggregate(values, agg) {
  if (!values.length) return null;
  if (agg === 'min') return Math.min(...values);
  if (agg === 'max') return Math.max(...values);
  let s = 0;
  for (const v of values) s += v;
  return tidy(agg === 'avg' ? s / values.length : s);
}

/**
 * The take-off table.
 *   ds    element metadata (three.js userData) of the elements to count
 *   spec  { groupBy: [names], columns: [{ name, agg, formula? }], itemize, sort: { by, dir } | null }
 *         itemize: one row per element (with its Element ID) instead of one per group;
 *         sort.by: a head key ('k0', 'count', 'c2' ...), dir 1 or -1
 *   opts  { resolve(name) -> the name as written in the model }
 * Returns {
 *   head: [{ key, kind: 'key'|'count'|'value', name, label, numeric, unit, places, agg, formula, error }],
 *   rows: [{ kind: 'group'|'item'|'subtotal'|'total', keys: [text], cells: [number|string|VARIES|null], members: [index into ds] }],
 * }  cells line up with head; keys with the 'key' columns (first in head).
 */
export function buildQto(ds, spec, opts = {}) {
  const resolve = opts.resolve ?? ((n) => n);
  const groupBy = (spec.groupBy ?? []).map(resolve);
  const keyNames = spec.itemize ? [...groupBy, ELEMENT_ID] : groupBy;
  const columns = (spec.columns ?? []).map((c) => {
    const col = { ...c, name: c.formula != null ? c.name : resolve(c.name), agg: c.agg ?? 'sum' };
    if (c.formula != null) {
      try {
        const f = compileFormula(c.formula);
        col.info = { numeric: true, unit: '', places: 2 };
        col.value = (d) => f.evaluate((n) => exactNumber(d, resolve(n)));
      } catch (err) {
        col.info = { numeric: false, unit: '', places: 0 };
        col.error = err.message;
        col.value = () => NaN;
      }
    } else {
      col.info = describeColumn(ds, col.name);
      col.value = col.info.numeric ? (d) => exactNumber(d, col.name) : (d) => valueKey(fieldValue(d, col.name));
    }
    return col;
  });

  const head = [
    ...keyNames.map((n, i) => ({ key: `k${i}`, kind: 'key', name: n, label: n })),
    { key: 'count', kind: 'count', name: COUNT, label: COUNT, numeric: true, places: 0 },
    ...columns.map((c, i) => ({
      key: `c${i}`, kind: 'value', name: c.name, numeric: c.info.numeric, unit: c.info.unit, places: c.info.places,
      agg: c.info.numeric ? c.agg : null, formula: c.formula ?? null, error: c.error ?? null, mixedUnits: !!c.info.mixedUnits,
      label: c.info.unit && !/\(.*\)\s*$/.test(c.name) ? `${c.name} (${c.info.unit})` : c.name,
    })),
  ];

  // each element's values once
  const values = ds.map((d) => columns.map((c) => c.value(d)));
  const cellsOf = (members) => [
    members.length,
    ...columns.map((c, ci) => {
      if (c.info.numeric) {
        const vs = [];
        for (const m of members) { const v = values[m][ci]; if (Number.isFinite(v)) vs.push(v); }
        return aggregate(vs, c.agg);
      }
      if (c.error) return null;
      const seen = new Set();
      for (const m of members) { const v = values[m][ci]; if (v !== NONE) seen.add(v); }
      return seen.size === 0 ? null : seen.size === 1 ? [...seen][0] : VARIES;
    }),
  ];

  // leaves: one per distinct combination of the key values
  const leaves = new Map();
  ds.forEach((d, i) => {
    const keys = keyNames.map((n, k) => (spec.itemize && k === keyNames.length - 1 ? String(d.id) : valueKey(fieldValue(d, n))));
    const k = JSON.stringify(keys);
    let g = leaves.get(k);
    if (!g) leaves.set(k, (g = { keys, members: [] }));
    g.members.push(i);
  });
  const leafKind = spec.itemize ? 'item' : 'group';
  const leafRows = [...leaves.values()].map((g) => ({ kind: leafKind, keys: g.keys, members: g.members, cells: [...g.keys, ...cellsOf(g.members)] }));

  // order: by the keys (natural, "(none)" last), or by the column the reader clicked
  const byKeys = (a, b) => {
    for (let i = 0; i < a.keys.length; i++) { const c = byKey(a.keys[i], b.keys[i]); if (c) return c; }
    return 0;
  };
  const col = spec.sort ? head.findIndex((h) => h.key === spec.sort.by) : -1;
  const dir = spec.sort?.dir === -1 ? -1 : 1;
  const cmp = (a, b) => {
    if (col < 0) return byKeys(a, b);
    const x = a.cells[col], y = b.cells[col];
    const empty = (v) => v == null || v === VARIES || v === NONE;
    if (empty(x) || empty(y)) return empty(x) - empty(y) || byKeys(a, b);   // blanks last, either way
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : natural(x, y);
    return c * dir || byKeys(a, b);
  };
  leafRows.sort(cmp);

  const rows = [];
  const nested = groupBy.length >= 1 && keyNames.length >= 2;
  if (nested) {
    // blocks by the first key, each followed by its subtotal (not for a block of one row: it is its own total)
    const blocks = new Map();
    for (const r of leafRows) {
      if (!blocks.has(r.keys[0])) blocks.set(r.keys[0], []);
      blocks.get(r.keys[0]).push(r);
    }
    let order = [...blocks.keys()].sort(byKey);
    if (col === 0) order = order.sort((a, b) => byKey(a, b) * (a === NONE || b === NONE ? 1 : dir));
    for (const k0 of order) {
      const block = blocks.get(k0);
      rows.push(...block);
      if (block.length < 2) continue;
      const members = block.flatMap((r) => r.members);
      const keys = keyNames.map((_, i) => (i === 0 ? k0 : i === keyNames.length - 1 ? 'Total' : ''));
      rows.push({ kind: 'subtotal', keys, members, cells: [...keys, ...cellsOf(members)] });
    }
  } else {
    rows.push(...leafRows);
  }
  if (keyNames.length) {
    const members = ds.map((_, i) => i);
    const keys = keyNames.map((_, i) => (i === 0 ? 'Total' : ''));
    rows.push({ kind: 'total', keys, members, cells: [...keys, ...cellsOf(members)] });
  } else if (!rows.length) {
    rows.push({ kind: 'total', keys: [], members: [], cells: cellsOf([]) });
  } else {
    rows[0].kind = 'total';   // no grouping: the one row is the total
  }
  return { head, rows };
}

/** A cell as text for the table: numbers in the reader's format with the column's decimals. */
export function cellText(v, h, locale) {
  if (v == null) return '';
  if (v === VARIES) return 'varies';
  if (typeof v === 'number') {
    const places = h.kind === 'count' ? 0 : h.places ?? 2;
    return v.toLocaleString(locale, { minimumFractionDigits: places, maximumFractionDigits: places });
  }
  return String(v);
}

/** The decimal separator of a locale ("," in most of Europe). */
export const decimalSeparator = (locale) => (1.5).toLocaleString(locale).replace(/\d/g, '')[0] ?? '.';

/**
 * CSV that Excel opens right in the reader's region: ";" between fields where the decimal
 * separator is a comma, else ","; numbers without digit grouping; UTF-8 with a BOM.
 */
export function toCsv(table, locale) {
  const decimal = decimalSeparator(locale);
  const sep = decimal === ',' ? ';' : ',';
  const quote = (s) => (/[",;\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const field = (v, h) => {
    if (v == null || v === VARIES) return '';
    if (typeof v === 'number') return v.toFixed(h.kind === 'count' ? 0 : h.places ?? 2).replace('.', decimal);
    return quote(String(v));
  };
  const lines = [table.head.map((h) => quote(h.label)).join(sep)];
  for (const r of table.rows) lines.push(r.cells.map((v, i) => field(v, table.head[i])).join(sep));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * The table as spreadsheet rows (for xlsx.js): a title block, then the header and the rows;
 * numbers stay numbers, with the column's decimals.
 *   meta: [[label, value], ...] lines above the table (model, view, date, which elements)
 */
export function toSheet(table, title, meta = []) {
  const rows = [[{ v: title, style: 'title' }]];
  for (const [k, v] of meta) rows.push([{ v: k, style: 'muted' }, { v }]);
  rows.push([]);
  const headRow = rows.length;
  rows.push(table.head.map((h) => ({ v: h.label, style: 'head', align: h.numeric ? 'right' : null })));
  for (const r of table.rows) {
    const bold = r.kind === 'subtotal' || r.kind === 'total';
    rows.push(r.cells.map((v, i) => {
      const h = table.head[i];
      if (v == null || v === VARIES) return bold ? { v: '', style: 'bold' } : null;
      if (typeof v === 'number') return { v, places: h.kind === 'count' ? 0 : h.places ?? 2, style: bold ? 'bold' : null };
      return { v: String(v), style: bold ? 'bold' : null };
    }));
  }
  // column widths from the longest text, within reason
  const widths = table.head.map((h, i) => {
    let w = h.label.length;
    for (const r of table.rows) {
      const v = r.cells[i];
      const len = typeof v === 'number' ? Math.abs(v).toFixed(h.places ?? 0).length + Math.floor(Math.log10(Math.max(1, Math.abs(v))) / 3) + 1 : v == null || v === VARIES ? 0 : String(v).length;
      w = Math.max(w, len);
    }
    return Math.min(60, Math.max(8, w + 2));
  });
  widths[0] = Math.max(widths[0], 14);
  return { rows, widths, freeze: headRow + 1 };
}
