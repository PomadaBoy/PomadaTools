// Colour by parameter: pure logic, testable in Node. The viewer turns each entry's
// tone into a colour from the page's CSS tokens (--cb-s1 ... in template.html).
//
// Values: one colour per distinct value, at most SLOTS of them, in a fixed slot
//   order; the rest fold into "Other" (grey). More hues would not be told apart.
// Range:  numbers in up to BINS steps with about as many elements each, on a one-hue
//   ramp, light (low) to dark (high). Equal-width steps would put nearly everything in
//   the first step whenever one element is much bigger than the rest.
import { parseNumber, NONE } from './filter.js';

export const SLOTS = 8;
export const BINS = 4;          // the light-theme ramp has four steps that stay distinct
export const OTHER = 'Other';
export const NOT_A_NUMBER = 'Not a number';

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const LEADING_NUMBER = /^\s*[-+−]?(?:\d[\d.,]*|[.,]\d+)/;
// A number as Revit writes one: "8.53 m³", "1,5", "1 234,5", "-3", "25.0280". Codes such as
// "5.1.3" and sizes such as "25 x 40" are text: after the number comes no digit.
const NUMBER_VALUE = /^\s*[-+−]?(?:\d{1,3}(?:[,. ' ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*[^\d\s.,][^\d]*)?\s*$/;

/** The number in a value written as a number (with or without a unit); NaN for anything else. */
export function numberOf(key) {
  return NUMBER_VALUE.test(key) ? parseNumber(key.replace(/(\d)[ ' ](?=\d{3}\b)/g, '$1')) : NaN;
}

/** Text key of a value: arrays are joined, null / '' -> NONE. */
export function valueKey(v) {
  if (Array.isArray(v)) v = v.filter((x) => x != null && String(x).trim() !== '').join(', ');
  if (v == null) return NONE;
  const s = String(v).trim();
  return s === '' ? NONE : s;
}

/** The unit written after the numbers ("8.53 m³" -> "m³") when every value has the same one. */
function commonUnit(keys) {
  let unit = null;
  for (const k of keys) {
    const rest = k.replace(LEADING_NUMBER, '').trim();
    if (unit == null) unit = rest;
    else if (rest !== unit) return '';
  }
  return unit ?? '';
}

/** Items that have at least one of the keys. */
const countItems = (items, keys) => items.filter((it) => (Array.isArray(it) ? it : [it]).some((k) => keys.has(k))).length;

/** Rounds for a legend label: enough decimals to tell neighbouring bounds apart. */
export function formatBound(x, step, locale) {
  const decimals = step > 0 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(step)) + 1)) : 2;
  return x.toLocaleString(locale, { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

/**
 * items: one value per element, or an array of values (an element with several
 * materials); null and '' are NONE. Counts are elements: a value counts once per item.
 * mode: 'auto' (range for numbers with more than SLOTS values), 'values' or 'range'.
 *
 * Returns {
 *   kind: 'values' | 'range', canRange,
 *   entries: [{ label, tone, count, keys?: [..] (Other), lo?, hi? (range) }],
 *   entryOf(key) -> index into entries
 * }
 * tones: 's1'..'s8', 'q1'..'q4', 'other', 'none'.
 */
export function colourScheme(rawItems, mode = 'auto', locale = undefined) {
  const items = rawItems.map((it) => (Array.isArray(it)
    ? [...new Set(it.map(valueKey))].filter((k) => k !== NONE)
    : valueKey(it)));
  const counts = new Map();
  for (const it of items) {
    for (const k of new Set(Array.isArray(it) ? (it.length ? it : [NONE]) : [it])) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const keys = [...counts.keys()].filter((k) => k !== NONE);
  const nums = new Map();
  for (const k of keys) {
    const n = numberOf(k);
    if (Number.isFinite(n)) nums.set(k, n);
  }
  const distinctNums = new Set(nums.values()).size;
  // range needs two different numbers
  const canRange = distinctNums >= 2;
  const allNumeric = keys.length > 0 && nums.size === keys.length;
  const kind = mode === 'range' && canRange ? 'range'
    : mode === 'auto' && canRange && allNumeric && keys.length > SLOTS ? 'range' : 'values';

  const entries = [];
  const index = new Map();
  const add = (entry, ks) => {
    entries.push(entry);
    for (const k of ks) index.set(k, entries.length - 1);
  };

  if (kind === 'values') {
    // the most common values get colours; shown, and coloured, in natural order
    const byCount = [...keys].sort((a, b) => counts.get(b) - counts.get(a) || natural(a, b));
    const coloured = byCount.slice(0, SLOTS).sort(natural);
    coloured.forEach((k, i) => add({ label: k, tone: `s${i + 1}`, count: counts.get(k) }, [k]));
    const rest = byCount.slice(SLOTS).sort(natural);
    if (rest.length) {
      const n = countItems(items, new Set(rest));
      add({ label: OTHER, tone: 'other', count: n, keys: rest.map((k) => ({ label: k, count: counts.get(k) })) }, rest);
    }
  } else {
    const unit = commonUnit([...nums.keys()]);
    const suffix = unit ? ` ${unit}` : '';
    // one number per element, sorted: the steps start at the quartiles
    const sorted = [];
    for (const [k, n] of nums) for (let c = counts.get(k); c > 0; c--) sorted.push(n);
    sorted.sort((a, b) => a - b);
    const min = sorted[0], max = sorted[sorted.length - 1];
    const starts = [min];
    for (let b = 1; b < BINS; b++) {
      const q = sorted[Math.floor((b * sorted.length) / BINS)];
      if (q > starts[starts.length - 1]) starts.push(q);
    }
    // decimals: enough to tell the closest bounds apart
    const gaps = [...starts, max].slice(1).map((v, i) => v - starts[i]).filter((g) => g > 0);
    const step = Math.min(...gaps, (max - min) / BINS);
    const nb = starts.length;
    const bins = starts.map((_, b) => ({
      label: '', tone: `q${nb === 1 ? 1 : 1 + Math.round((b * (BINS - 1)) / (nb - 1))}`,
      count: 0, lo: Infinity, hi: -Infinity, keys: [],
    }));
    for (const [k, n] of nums) {
      let b = nb - 1;
      while (b > 0 && n < starts[b]) b--;
      const bin = bins[b];
      bin.count += counts.get(k);
      bin.keys.push(k);
      bin.lo = Math.min(bin.lo, n);
      bin.hi = Math.max(bin.hi, n);
    }
    // labels: the smallest and largest number in each step
    for (const bin of bins) {
      const lo = formatBound(bin.lo, step, locale), hi = formatBound(bin.hi, step, locale);
      bin.label = (lo === hi ? lo : `${lo} – ${hi}`) + suffix;
    }
    for (const bin of bins) {
      const ks = bin.keys;
      delete bin.keys;
      add(bin, ks);
    }
    const text = keys.filter((k) => !nums.has(k)).sort(natural);
    if (text.length) {
      const n = countItems(items, new Set(text));
      add({ label: NOT_A_NUMBER, tone: 'other', count: n, keys: text.map((k) => ({ label: k, count: counts.get(k) })) }, text);
    }
  }
  if (counts.has(NONE)) add({ label: NONE, tone: 'none', count: counts.get(NONE) }, [NONE]);
  return { kind, canRange, entries, entryOf: (value) => index.get(valueKey(value)) ?? index.get(NONE) ?? -1 };
}
