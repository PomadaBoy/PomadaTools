// Filtering by properties: pure logic on element metadata (three.js userData), so
// it can be tested in Node. An element matches when it passes the search, every
// facet and the rules (combined with AND or OR).

export const OPERATORS = [
  { id: 'eq', label: 'equals' },
  { id: 'ne', label: 'does not equal' },
  { id: 'contains', label: 'contains' },
  { id: 'ncontains', label: 'does not contain' },
  { id: 'begins', label: 'begins with' },
  { id: 'gt', label: '>' },
  { id: 'ge', label: '≥' },
  { id: 'lt', label: '<' },
  { id: 'le', label: '≤' },
  { id: 'has', label: 'has value' },
  { id: 'hasnot', label: 'has no value' },
];
const NO_VALUE = new Set(['has', 'hasnot']);
const NUMERIC = new Set(['gt', 'ge', 'lt', 'le']);
const NEGATIVE = { ne: 'eq', ncontains: 'contains', hasnot: 'has' };

export const NONE = '(none)';

/** Quick facets: checkbox lists. A facet value of null or '' is shown as "(none)". */
export const FACETS = [
  { key: 'category', label: 'Category', values: (d) => [d.category] },
  { key: 'family', label: 'Family', values: (d) => [d.family] },
  { key: 'type', label: 'Type', values: (d) => [d.type] },
  { key: 'level', label: 'Level', values: (d) => [d.level] },
  { key: 'material', label: 'Material', values: (d) => (d.materials?.length ? d.materials : [null]) },
];

export function facetValues(d, facet) {
  return facet.values(d).map((v) => (v == null || v === '' ? NONE : String(v)));
}

/** Fields every element has, usable in rules next to the Revit parameter names. */
export const FIELDS = {
  'Element ID': (d) => d.id,
  Category: (d) => d.category,
  Family: (d) => d.family,
  Type: (d) => d.type,
  Level: (d) => d.level,
  Mark: (d) => d.mark,
  Comments: (d) => d.comments,
  Material: (d) => d.materials ?? [],
  'Volume (m³)': (d) => d.volume_m3,
  Link: (d) => d.link,
  'Unique ID': (d) => d.uniqueId,
};

/**
 * The leading number of a display string: "8.53 m³" -> 8.53, "1,5" -> 1.5,
 * "25.0280" -> 25.028, "-3" -> -3, "1.234,5" -> 1234.5, "1,234.5" -> 1234.5.
 * NaN when the text does not start with a number.
 */
export function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const s = String(v).trim().replace(/−/g, '-');
  const m = s.match(/^[-+]?(?:\d[\d.,]*|[.,]\d+)/);
  if (!m) return NaN;
  let t = m[0].replace(/[.,]+$/, '');
  const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length;
  if (dots && commas) {
    // both: the last one is the decimal separator, the other groups thousands
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (commas === 1) {
    t = t.replace(',', '.');
  } else if (commas > 1) {
    t = t.replace(/,/g, '');
  } else if (dots > 1) {
    t = t.replace(/\./g, '');
  }
  return parseFloat(t);
}

const isPlainNumber = (s) => /^\s*[-+−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)\s*$/.test(String(s));
const lower = (v) => String(v).trim().toLocaleLowerCase();

/** Value of a parameter or field: instance parameters, then type parameters, then FIELDS. */
export function fieldValue(d, name) {
  if (d.params && Object.prototype.hasOwnProperty.call(d.params, name)) return d.params[name];
  if (d.typeParams && Object.prototype.hasOwnProperty.call(d.typeParams, name)) return d.typeParams[name];
  const f = FIELDS[name];
  return f ? f(d) : undefined;
}

const hasValue = (v) => v != null && String(v).trim() !== '';

function testOne(v, op, value) {
  switch (op) {
    case 'has': return hasValue(v);
    case 'eq': {
      if (!hasValue(v)) return false;
      if (lower(v) === lower(value)) return true;
      // "8.53" equals "8.53 m³", "1.5" equals "1,5"
      if (isPlainNumber(value)) {
        const a = parseNumber(v), b = parseNumber(value);
        return Number.isFinite(a) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
      }
      return false;
    }
    case 'contains': return hasValue(v) && lower(v).includes(lower(value));
    case 'begins': return hasValue(v) && lower(v).startsWith(lower(value));
    default: {
      const a = parseNumber(v), b = parseNumber(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'ge') return a >= b;
      if (op === 'lt') return a < b;
      if (op === 'le') return a <= b;
      return false;
    }
  }
}

/** A rule is complete when it has a parameter name and, if the operator needs one, a value. */
export function ruleComplete(rule) {
  return !!(rule && rule.name && rule.name.trim() && (NO_VALUE.has(rule.op) || String(rule.value ?? '').trim() !== ''));
}

export const operatorNeedsValue = (op) => !NO_VALUE.has(op);
export const operatorIsNumeric = (op) => NUMERIC.has(op);

/**
 * Tests one rule. Multi-valued fields (Material) match when any value matches;
 * the negative operators then mean that no value matches.
 */
export function testRule(d, rule, resolveName = (n) => n) {
  const v = fieldValue(d, resolveName(rule.name.trim()));
  const positive = NEGATIVE[rule.op] ?? rule.op;
  const values = Array.isArray(v) ? v : [v];
  const any = (values.length ? values : [undefined]).some((x) => testOne(x, positive, rule.value ?? ''));
  return NEGATIVE[rule.op] ? !any : any;
}

/** Text the search box looks in: ID, names and every parameter value, lower case. */
export function searchText(d) {
  const parts = [d.id, d.category, d.family, d.type, d.level, d.mark, d.comments, d.link, ...(d.materials ?? [])];
  for (const v of Object.values(d.params ?? {})) parts.push(v);
  for (const v of Object.values(d.typeParams ?? {})) parts.push(v);
  return parts.filter((x) => x != null && x !== '').join('\n').toLocaleLowerCase();
}

/**
 * state: {
 *   search: string,
 *   excluded: { [facetKey]: Set<string> }   unchecked facet values
 *   rules: [{ name, op, value }],
 *   combine: 'and' | 'or',
 * }
 */
export function emptyFilter() {
  return { search: '', excluded: Object.fromEntries(FACETS.map((f) => [f.key, new Set()])), rules: [], combine: 'and' };
}

export function filterActive(state) {
  return !!(state.search.trim() || FACETS.some((f) => state.excluded[f.key]?.size) || state.rules.some(ruleComplete));
}

/** el: { d (userData), text (searchText) } */
export function matches(el, state, resolveName) {
  const d = el.d;
  const terms = state.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const text = el.text ?? searchText(d);
    if (!terms.every((t) => text.includes(t))) return false;
  }
  for (const f of FACETS) {
    const ex = state.excluded[f.key];
    if (ex?.size && !facetValues(d, f).some((v) => !ex.has(v))) return false;
  }
  const rules = state.rules.filter(ruleComplete);
  if (rules.length) {
    const test = (r) => testRule(d, r, resolveName);
    if (state.combine === 'or' ? !rules.some(test) : !rules.every(test)) return false;
  }
  return true;
}
