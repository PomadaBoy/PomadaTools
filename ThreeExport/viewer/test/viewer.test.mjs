// Opens the packaged synthetic model (tests/out/synthetic.html, written by the C#
// tests) in headless Chromium from file://, as a user double-clicking the file would.
//   dotnet test ../tests/RevitThreeExport.Tests && node --test test/viewer.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { emptyFilter, matches, searchText } from '../src/filter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'tests', 'out');
const html = path.join(out, 'synthetic.html');
const stats = JSON.parse(fs.readFileSync(path.join(out, 'synthetic.stats.json'), 'utf8'));
// software WebGL in headless Chromium
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// element metadata straight from the .glb, to compute expected filter results
const glb = fs.readFileSync(path.join(out, 'synthetic.glb'));
const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
const data = gltf.nodes.filter((n) => n.extras?.id && n.extras?.category).map((n) => n.extras);
const expectIds = (state) => data.filter((d) => matches({ d, text: searchText(d) }, state)).map((d) => d.id).sort();
const ruleState = (...rules) => ({ ...emptyFilter(), rules: rules.map(([name, op, value = '']) => ({ name, op, value })) });

let browser;
before(async () => { browser = await chromium.launch({ args }); });
after(async () => { await browser?.close(); });

async function open({ viewport = { width: 1280, height: 800 }, reducedMotion = 'reduce', init } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion, acceptDownloads: true });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  if (init) await page.addInitScript(init);
  // the offline file must not need the network (fonts may fail; they fall back)
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(html).href);
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  await page.waitForSelector('#status', { state: 'hidden' });
  const fontErrors = (e) => !/fonts\.googleapis|ERR_FAILED|net::/.test(e);
  return { page, errors: () => errors.filter(fontErrors) };
}

const els = (page) => page.evaluate(() => window.viewer.elements());
const count = async (page) => {
  const t = await page.textContent('#f-count');
  const m = t.match(/^(\d+) of (\d+)/) ?? t.match(/^(\d+) elements/);
  return Number(m[1]);
};
const matchIds = async (page) => (await els(page)).filter((e) => e.match).map((e) => e.id).sort();

async function setRule(page, name, op, value = '') {
  if (!(await page.locator('#f-rules .rule').count())) await page.click('#f-add');
  await page.fill('#f-rules .rule .r-name', name);
  await page.selectOption('#f-rules .rule .r-op', op);
  if (await page.locator('#f-rules .rule .r-val').isEnabled()) await page.fill('#f-rules .rule .r-val', value);
  await page.locator('#f-search').press('Enter');   // apply now instead of after the typing pause
}

test('loads the gzip+base64 model with no console errors', async () => {
  const { page, errors } = await open({ reducedMotion: 'no-preference' });
  assert.deepEqual(errors(), []);
  assert.equal(await page.textContent('#doc-title'), 'Sintetički model');
  const cats = await page.textContent('#doc-cats');
  assert.match(cats, new RegExp(`^${stats.elements} elements: `));
  for (const [c, n] of Object.entries(stats.perCategory)) assert.ok(cats.includes(`${c} ${n}`), `${c} ${n} in "${cats}"`);
  assert.match(await page.textContent('#doc-meta'), /Revit view "Export" · exported 2026-11-24 12:00/);
  assert.equal(await count(page), stats.elements);
  await page.close();
});

test('clicking an element opens the inspect panel, Esc closes it', async () => {
  const { page, errors } = await open();
  const box = await page.locator('#viewport canvas').boundingBox();
  // the camera is fitted on the building, so the middle of the canvas hits it
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height / 2);
  await page.waitForSelector('#panel:not([hidden])', { timeout: 5000 });
  const chip = await page.textContent('#panel .chip');
  assert.ok(Object.keys(stats.perCategory).includes(chip), `category chip "${chip}"`);
  assert.match(await page.textContent('#panel .idrow code'), /^\d+$/);
  assert.ok(await page.locator('#panel .mats li').count() >= 1);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#panel', { state: 'hidden' });
  assert.deepEqual(errors(), []);
  await page.close();
});

test('explode moves elements in each mode and Reset restores the exact original positions', async () => {
  const { page, errors } = await open();
  await page.click('#tb-explode');
  const original = await els(page);
  for (const e of original) assert.deepEqual(e.position, e.original);

  for (const mode of ['centre', 'vertical', 'category']) {
    await page.click(`#explode-mode [data-mode="${mode}"]`);
    await page.fill('#explode-amount', '100');
    assert.equal(await page.textContent('#explode-value'), '100%');
    const moved = await els(page);
    const offsets = moved.map((e) => e.position.map((v, k) => v - e.original[k]));
    assert.ok(offsets.some((o) => Math.hypot(...o) > 1), `${mode}: something moved`);
    if (mode !== 'centre') {
      assert.ok(offsets.every((o) => Math.abs(o[0]) < 1e-9 && Math.abs(o[2]) < 1e-9), `${mode}: Y only`);
      assert.ok(offsets.every((o) => o[1] >= -1e-9), `${mode}: never down`);
    }
    if (mode === 'category') {
      const byCat = new Map();
      moved.forEach((e, i) => { (byCat.get(e.category) ?? byCat.set(e.category, new Set()).get(e.category)).add(offsets[i][1].toFixed(6)); });
      for (const [c, ys] of byCat) assert.equal(ys.size, 1, `${c} moves as one group`);
    }
    await page.click('#explode-reset');
    assert.equal(await page.inputValue('#explode-amount'), '0');
    const back = await els(page);
    back.forEach((e, i) => assert.deepEqual(e.position, original[i].original, `${mode}: element ${e.id} back exactly`));
  }
  assert.deepEqual(errors(), []);
  await page.close();
});

test('explode animates and still ends exactly on the original positions', async () => {
  const { page } = await open({ reducedMotion: 'no-preference' });
  await page.click('#tb-explode');
  await page.fill('#explode-amount', '80');
  assert.equal((await page.evaluate(() => window.viewer.state())).explode.animating, true);
  await page.waitForFunction(() => !window.viewer.state().explode.animating);
  assert.ok((await els(page)).some((e) => e.position.some((v, k) => Math.abs(v - e.original[k]) > 1)));
  await page.click('#explode-reset');
  await page.waitForFunction(() => !window.viewer.state().explode.animating);
  for (const e of await els(page)) assert.deepEqual(e.position, e.original);
  await page.close();
});

test('picking and fit keep working while exploded', async () => {
  const { page } = await open();
  await page.click('#tb-explode');
  await page.click('#explode-mode [data-mode="vertical"]');
  await page.fill('#explode-amount', '100');
  await page.click('#fit');
  // every element is inside the canvas after fitting the exploded model
  const box = await page.locator('#viewport canvas').boundingBox();
  for (const e of await els(page)) {
    const [x, y] = await page.evaluate((id) => window.viewer.screenPoint(id), e.id);
    assert.ok(x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height, `element ${e.id} in view`);
  }
  // the roof slabs rise the most: click one where it is now
  const roof = (await els(page)).find((e) => e.category === 'Roofs');
  const [x, y] = await page.evaluate((id) => window.viewer.screenPoint(id), roof.id);
  await page.mouse.click(x, y);
  await page.waitForSelector('#panel:not([hidden])');
  assert.equal(await page.textContent('#panel .chip'), 'Roofs');
  await page.close();
});

test('every filter operator, including numbers in "8.53 m³" and "1,5"', async () => {
  const { page, errors } = await open();
  await page.click('#tb-filter');
  const cases = [
    ['Dilatacija', 'eq', 'novi most'], ['Dilatacija', 'ne', 'Novi most'],
    ['Type', 'contains', 'kulir'], ['Type', 'ncontains', 'Ploča'], ['Type', 'begins', 'zid'],
    ['Volume', 'gt', '8'], ['Volume', 'ge', '8.53'], ['Volume', 'lt', '0,8'], ['Volume', 'le', '0.72'],
    ['Volume', 'eq', '8.53'], ['Faktor', 'gt', '1,5'], ['Faktor', 'eq', '1.5'], ['Faktor', 'le', '2'],
    ['Width', 'lt', '0.3'], ['Mark', 'has'], ['Comments', 'hasnot'], ['volume', 'gt', '20'],
    ['Element ID', 'eq', '843064'], ['Level', 'eq', 'Nula'], ['Material', 'contains', 'čelik'],
  ];
  for (const [name, op, value] of cases) {
    await setRule(page, name, op, value);
    const expected = expectIds(ruleState([name.toLowerCase() === 'volume' ? 'Volume' : name, op, value]));
    assert.ok(expected.length > 0 && expected.length < data.length, `${name} ${op} ${value} should be a real test (${expected.length})`);
    assert.equal(await count(page), expected.length, `${name} ${op} ${value}`);
    assert.deepEqual(await matchIds(page), expected, `${name} ${op} ${value}`);
  }
  // the checklist element: Volume 8.53 m³ (display string) matches numerically
  await setRule(page, 'Volume', 'ge', '8.53');
  assert.ok((await matchIds(page)).includes(843064));
  await setRule(page, 'Volume', 'gt', '8.53');
  assert.ok(!(await matchIds(page)).includes(843064));
  assert.deepEqual(errors(), []);
  await page.close();
});

test('two rules combine with AND or OR', async () => {
  const { page } = await open();
  await page.click('#tb-filter');
  await page.click('#f-add');
  await page.click('#f-add');
  const rows = page.locator('#f-rules .rule');
  await rows.nth(0).locator('.r-name').fill('Category');
  await rows.nth(0).locator('.r-val').fill('Walls');
  await rows.nth(1).locator('.r-name').fill('Level');
  await rows.nth(1).locator('.r-val').fill('Nula');
  await page.locator('#f-search').press('Enter');
  const both = expectIds(ruleState(['Category', 'eq', 'Walls'], ['Level', 'eq', 'Nula']));
  assert.equal(await count(page), both.length);
  assert.ok(await page.isVisible('#f-combine'));
  await page.selectOption('#f-combine', 'or');
  const either = expectIds({ ...ruleState(['Category', 'eq', 'Walls'], ['Level', 'eq', 'Nula']), combine: 'or' });
  assert.equal(await count(page), either.length);
  assert.ok(either.length > both.length);
  await page.close();
});

test('Isolate, Ghost and Hide matching show the right elements', async () => {
  const { page } = await open();
  await page.click('#tb-filter');
  await setRule(page, 'Category', 'eq', 'Walls');
  const n = stats.perCategory.Walls, all = stats.elements;
  const summary = async () => {
    const e = await els(page);
    return { match: e.filter((x) => x.match).length, shown: e.filter((x) => x.shown).length, ghost: e.filter((x) => x.ghost).length };
  };
  assert.deepEqual(await summary(), { match: n, shown: n, ghost: 0 });
  assert.equal(await page.textContent('#f-count'), `${n} of ${all} elements`);
  await page.click('#f-mode [data-mode="ghost"]');
  assert.deepEqual(await summary(), { match: n, shown: all, ghost: all - n });
  await page.click('#f-mode [data-mode="hide"]');
  assert.deepEqual(await summary(), { match: n, shown: all - n, ghost: 0 });
  // ghosts cannot be picked: in ghost mode only walls can be selected
  await page.click('#f-mode [data-mode="ghost"]');
  const box = await page.locator('#viewport canvas').boundingBox();
  for (const [fx, fy] of [[0.42, 0.5], [0.5, 0.45], [0.55, 0.6], [0.35, 0.55]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    const sel = (await page.evaluate(() => window.viewer.state())).selected;
    if (sel != null) assert.ok((await els(page)).find((e) => e.id === sel && e.category === 'Walls'), `picked ${sel} is a wall`);
  }
  await page.click('#f-clear');
  assert.deepEqual(await summary(), { match: all, shown: all, ghost: 0 });
  assert.equal(await page.textContent('#f-count'), `${all} elements`);
  await page.close();
});

test('search looks in IDs, names and every parameter value', async () => {
  const { page } = await open();
  await page.click('#tb-filter');
  for (const q of ['843064', 'šđčćž', 'kulir', 'HEB 300', 'stari most', 'M-7']) {
    await page.fill('#f-search', q);
    await page.locator('#f-search').press('Enter');
    const expected = expectIds({ ...emptyFilter(), search: q });
    assert.ok(expected.length > 0, q);
    assert.deepEqual(await matchIds(page), expected, q);
  }
  await page.fill('#f-search', 'nothing like this');
  await page.locator('#f-search').press('Enter');
  assert.equal(await count(page), 0);
  assert.match(await page.textContent('#f-list'), /No element matches/);
  await page.close();
});

test('facets: unchecking values, None and All', async () => {
  const { page } = await open();
  await page.click('#tb-filter');
  const cat = page.locator('#f-facets details[data-facet="category"]');
  await cat.locator('summary').click();
  await cat.locator('input[value="Walls"]').uncheck();
  assert.equal(await count(page), stats.elements - stats.perCategory.Walls);
  assert.equal(await cat.locator('.off').textContent(), '1 off');
  await cat.locator('[data-none]').click();
  assert.equal(await count(page), 0);
  await cat.locator('[data-all]').click();
  assert.equal(await count(page), stats.elements);
  const mat = page.locator('#f-facets details[data-facet="material"]');
  await mat.locator('summary').click();
  await mat.locator('[data-none]').click();
  await mat.locator('input[value="Kulir"]').check();
  assert.deepEqual(await matchIds(page), [843064]);
  await page.close();
});

test('the results list selects and zooms; Copy filtered IDs leaves out linked elements', async () => {
  let copied = null;
  const { page } = await open({
    init: () => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
    },
  });
  await page.click('#tb-filter');
  await setRule(page, 'Level', 'eq', 'Nula');
  const expected = expectIds(ruleState(['Level', 'eq', 'Nula']));
  const linked = data.filter((d) => d.link && expected.includes(d.id)).map((d) => d.id);
  assert.equal(linked.length, 3, 'the synthetic model has 3 linked foundations on Nula');
  await page.click('#f-copy');
  copied = (await page.evaluate(() => window.__copied)).at(-1);
  assert.deepEqual(copied.split(',').map(Number).sort(), expected.filter((id) => !linked.includes(id)));
  assert.match(await page.textContent('#f-copy'), new RegExp(`Copied ${expected.length - 3} IDs`));
  // the list: click an item -> selected and highlighted in the list
  const item = page.locator('#f-list button').nth(2);
  const id = Number(await item.locator('code').textContent());
  await item.click();
  assert.equal((await page.evaluate(() => window.viewer.state())).selected, id);
  assert.equal(await item.getAttribute('aria-current'), 'true');
  assert.equal(await page.textContent('#panel .idrow code'), String(id));
  await page.close();
});

test('Download .glb saves the model', async () => {
  const { page } = await open();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tb-download')]);
  assert.equal(download.suggestedFilename(), 'Sintetički model_Export.glb');
  const file = await download.path();
  assert.deepEqual(fs.readFileSync(file), glb);
  await page.close();
});

const state = (page) => page.evaluate(() => window.viewer.state());
const shownCount = async (page) => (await els(page)).filter((e) => e.shown).length;
const byId = (id) => data.find((d) => d.id === id);

/** Clicks the middle of the model and returns the selected element's metadata. */
async function clickModel(page) {
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height / 2);
  await page.waitForSelector('#panel:not([hidden])');
  return byId((await state(page)).selected);
}

/** Selects an element through the search box and the results list. */
async function selectById(page, id) {
  if (!(await page.isVisible('#filter'))) await page.click('#tb-filter');
  await page.fill('#f-search', String(id));
  await page.locator('#f-search').press('Enter');
  await page.locator(`#f-list button[data-i]`).first().click();
  assert.equal((await state(page)).selected, id);
  await page.click('#f-clear');
}

test('Hide and Isolate from the bar at the clicked element, with Undo and Show all', async () => {
  const { page, errors } = await open();
  const d = await clickModel(page);
  assert.ok(await page.isVisible('#pick'), 'the bar shows at the clicked element');
  assert.ok(await page.isVisible('#pick-dot'));
  const all = stats.elements;

  await page.click('#pk-hide');
  let s = await state(page);
  assert.equal(s.hidden, 1);
  assert.equal(s.selected, null, 'a hidden element is no longer selected');
  assert.ok(await page.isHidden('#pick'));
  assert.equal(await shownCount(page), all - 1);
  assert.equal((await els(page)).find((e) => e.id === d.id).shown, false);
  assert.equal(await page.textContent('#vis-text'), 'Hidden: 1 element');
  await page.click('#vis-undo');
  assert.equal((await state(page)).hidden, 0);
  assert.equal(await shownCount(page), all);
  assert.ok(await page.isHidden('#vis'));

  // Isolate ▼ Same category: only that category; the selection stays
  await clickModel(page);
  await page.click('#pick .pk-more[data-act="isolate"]');
  assert.ok(await page.isVisible('#pk-menu'));
  const n = stats.perCategory[d.category];
  assert.equal(await page.textContent('#pk-menu [data-scope="category"] .n'), String(n));
  assert.equal(await page.textContent('#pk-menu [data-scope="element"] .n'), '1');
  const sameType = data.filter((x) => x.category === d.category && x.family === d.family && x.type === d.type).length;
  assert.equal(await page.textContent('#pk-menu [data-scope="type"] .n'), String(sameType));
  await page.click('#pk-menu [data-scope="category"]');
  assert.ok(await page.isHidden('#pk-menu'));
  s = await state(page);
  assert.equal(s.isolated, n);
  assert.equal(s.selected, d.id);
  const shown = (await els(page)).filter((e) => e.shown);
  assert.equal(shown.length, n);
  assert.ok(shown.every((e) => e.category === d.category));
  assert.equal(await page.textContent('#vis-text'), `Isolated: ${n} elements`);

  // Hide ▼ Same type, inside the isolated category
  await page.click('#pick .pk-more[data-act="hide"]');
  await page.click('#pk-menu [data-scope="type"]');
  assert.equal(await shownCount(page), n - sameType);
  assert.match(await page.textContent('#vis-text'), new RegExp(`^Isolated: ${n} elements · Hidden: ${sameType} elements$`));
  await page.click('#vis-all');
  assert.equal(await shownCount(page), all);
  assert.deepEqual([(await state(page)).hidden, (await state(page)).isolated], [0, null]);
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Revit shortcuts: HH, HI, HC, IC, HR and Ctrl+Z; typing in a box does not trigger them', async () => {
  const { page } = await open();
  const all = stats.elements;
  const d = await clickModel(page);
  const n = stats.perCategory[d.category];
  const keys = async (...k) => { for (const x of k) await page.keyboard.press(x); };

  await keys('h', 'i');
  assert.equal(await shownCount(page), 1);
  await keys('h', 'r');
  assert.equal(await shownCount(page), all);
  await keys('i', 'c');
  assert.equal(await shownCount(page), n);
  await keys('Control+z');
  assert.equal(await shownCount(page), all, 'Ctrl+Z undoes IC');
  await keys('h', 'c');
  assert.equal(await shownCount(page), all - n);
  assert.equal((await state(page)).selected, null);
  await keys('h', 'r');
  assert.equal(await shownCount(page), all);

  await selectById(page, 843064);
  await page.locator('#f-search').focus();
  await keys('h', 'h');
  assert.equal(await shownCount(page), all, 'keys typed in the search box are text');
  await page.locator('#f-search').fill('');
  await page.evaluate(() => document.activeElement.blur());
  await keys('h', 'h');
  assert.equal((await els(page)).find((e) => e.id === 843064).shown, false);

  // the results list shows hand-hidden elements dimmed; picking one shows it again
  await page.fill('#f-search', '843064');
  await page.locator('#f-search').press('Enter');
  const item = page.locator('#f-list button[data-i]').first();
  assert.equal(await item.getAttribute('class'), 'off');
  await item.click();
  assert.equal((await els(page)).find((e) => e.id === 843064).shown, true);
  assert.equal((await state(page)).selected, 843064);
  await page.close();
});

test('property rows: Filter on value, Colour by and Copy value', async () => {
  const { page } = await open({
    init: () => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
    },
  });
  await selectById(page, 843064);
  await page.click('#tb-filter');   // closed: Filter on value must open it again
  assert.ok(await page.isHidden('#filter'));

  const rowAction = async (field, action) => {
    const r = page.locator(`#panel [data-f="${field}"]`).first();
    await r.hover();
    await r.locator(`[data-a="${action}"]`).click();
  };
  await rowAction('Level', 'filter');
  assert.ok(await page.isVisible('#filter'));
  assert.equal(await page.inputValue('#f-rules .rule .r-name'), 'Level');
  assert.equal(await page.inputValue('#f-rules .rule .r-op'), 'eq');
  assert.equal(await page.inputValue('#f-rules .rule .r-val'), 'Nula');
  assert.deepEqual(await matchIds(page), expectIds(ruleState(['Level', 'eq', 'Nula'])));

  await rowAction('Type', 'filter');
  assert.equal(await page.locator('#f-rules .rule').count(), 2);
  assert.deepEqual(await matchIds(page), expectIds(ruleState(['Level', 'eq', 'Nula'], ['Type', 'eq', 'Obloga od Kulira'])));
  // a second value of the same parameter replaces the first, instead of matching nothing
  await rowAction('Level', 'filter');
  assert.equal(await page.locator('#f-rules .rule').count(), 2);

  // an instance parameter, as Revit writes it
  await page.click('#f-clear');
  await page.locator('#panel details summary', { hasText: 'Instance parameters' }).click();
  await rowAction('Volume', 'filter');
  assert.equal(await page.inputValue('#f-rules .rule .r-val'), '8.53 m³');
  assert.deepEqual(await matchIds(page), expectIds(ruleState(['Volume', 'eq', '8.53 m³'])));
  // the material list
  await page.click('#f-clear');
  await rowAction('Material', 'filter');
  assert.deepEqual(await matchIds(page), [843064]);

  await rowAction('Level', 'copy');
  assert.equal((await page.evaluate(() => window.__copied)).at(-1), 'Nula');

  await rowAction('Type', 'colour');
  assert.ok(await page.isVisible('#colour'));
  const c = (await state(page)).colour;
  assert.equal(c.field, 'Type');
  assert.equal(c.kind, 'values');
  assert.equal(c.entries.reduce((a, e) => a + e.count, 0), stats.elements);
  assert.equal(await page.inputValue('#c-field'), 'Type');
  await page.close();
});

test('Colour by: values, Other, number range, material per part, legend, theme and Off', async () => {
  const { page, errors } = await open();
  const original = await els(page);
  await page.click('#tb-colour');
  assert.ok(await page.isVisible('#colour'));
  assert.equal(await page.isDisabled('#c-kind [data-kind="range"]'), true);

  // every drawn colour is its legend colour
  const checkColours = async () => {
    const s = await state(page);
    for (const e of await els(page)) {
      for (const [k, col] of e.colours.entries()) {
        const tone = e.tones.length === 1 ? e.tones[0] : null;
        if (tone) assert.equal(col, s.colour.tones[tone], `${e.id} part ${k}`);
        else assert.ok(Object.values(s.colour.tones).includes(col), `${e.id} part ${k}: ${col}`);
      }
    }
  };

  await page.click('#c-quick [data-field="Category"]');
  let s = (await state(page)).colour;
  assert.deepEqual(s.entries.map((e) => [e.label, e.count]), Object.entries(stats.perCategory));
  assert.deepEqual(s.entries.map((e) => e.tone), ['s1', 's2', 's3', 's4', 's5', 's6']);
  assert.equal(await page.locator('#c-legend > li').count(), 6);
  assert.equal(await page.getAttribute('#c-quick [data-field="Category"]', 'aria-pressed'), 'true');
  assert.ok(await page.isVisible('#tb-colour-dot'));
  await checkColours();

  // ten types: eight colours and Other
  await page.click('#c-quick [data-field="Type"]');
  s = (await state(page)).colour;
  assert.equal(s.entries.length, 9);
  assert.equal(s.entries.at(-1).label, 'Other');
  assert.match(await page.textContent('#c-note'), /^10 values: the 8 most common have colours/);
  assert.equal(await page.textContent('#c-legend details summary'), '2 values');
  await checkColours();

  // materials colour each part: the floors' ceramic top differs from the concrete body
  await page.click('#c-quick [data-field="Material"]');
  const floor = (await els(page)).find((e) => e.category === 'Floors');
  assert.equal(floor.tones.length, 2);
  assert.notEqual(floor.colours[0], floor.colours[1]);
  await checkColours();

  // a typed parameter name; numbers can be shown as a range
  await page.fill('#c-field', 'volume');
  s = (await state(page)).colour;
  assert.equal(s.field, 'Volume');
  assert.equal(s.kind, 'values');
  assert.equal(s.canRange, true);
  await page.click('#c-kind [data-kind="range"]');
  s = (await state(page)).colour;
  assert.equal(s.kind, 'range');
  assert.deepEqual(s.entries.map((e) => e.tone), ['q1', 'q2', 'q3', 'q4']);
  assert.equal(s.entries.reduce((a, e) => a + e.count, 0), stats.elements);
  assert.deepEqual(s.entries.map((e) => [e.label, e.count]), [['0.72 m³', 72], ['0.93 m³', 64], ['2.02 – 8.53 m³', 77], ['9.25 – 30 m³', 92]]);
  await checkColours();

  // unticking a legend row hides those elements; ticking shows them again
  await page.locator('#c-legend input[data-entry="0"]').uncheck();
  assert.equal((await state(page)).hidden, s.entries[0].count);
  assert.equal(await shownCount(page), stats.elements - s.entries[0].count);
  assert.ok(await page.isVisible('#vis'));
  await page.locator('#c-legend input[data-entry="0"]').check();
  assert.equal(await shownCount(page), stats.elements);

  // the colours follow the page theme
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => window.viewer.state().colour.tones.q1 === '#184f95');
  await checkColours();

  await page.click('#c-off');
  assert.equal((await state(page)).colour, null);
  assert.ok(await page.isHidden('#tb-colour-dot'));
  assert.deepEqual((await els(page)).map((e) => e.colours), original.map((e) => e.colours));
  assert.deepEqual(errors(), []);
  await page.close();
});

// ---------- cuts ----------
const cutState = async (page) => (await state(page)).cuts;
/** Where along its axis a square plane sits: n·p + c = 0. */
const planeAt = (p) => { const k = p.normal.findIndex((v) => Math.abs(v) === 1); return { k, v: -p.constant / p.normal[k] }; };

test('Cut: Add cut on the clicked face, move it, Flip and Remove; clicks skip what is cut away', async () => {
  const { page, errors } = await open();
  const box = await page.locator('#viewport canvas').boundingBox();
  const at = [box.x + box.width * 0.3, box.y + box.height * 0.55];
  await page.mouse.click(...at);
  const wall = (await state(page)).selected;
  assert.ok(wall, 'clicked an element');
  const el = (await els(page)).find((e) => e.id === wall);
  await page.click('#pk-cut');
  let c = await cutState(page);
  assert.equal(c.planes.length, 1);
  assert.ok(await page.isVisible('#cuts'));
  // a square plane on one face of the clicked element, keeping what is behind that face
  const { k, v } = planeAt(c.planes[0]);
  assert.ok(k >= 0, `square normal ${c.planes[0].normal}`);
  assert.ok([el.box[0][k], el.box[1][k]].some((f) => Math.abs(f - v) < 1e-6), `plane at ${v}, element ${el.box[0][k]}..${el.box[1][k]}`);
  assert.equal(c.planes[0].offset, 0);

  // again from near one end of that face, so the arrow (where the face was clicked) is away
  // from the point used to check picking, near the other end
  await page.click('#cut-list [data-a="remove"]');
  const onFace = (frac) => {
    const p = [0, 1, 2].map((i) => (el.box[0][i] + el.box[1][i]) / 2);
    // along the face's longer horizontal side
    const span = (i) => el.box[1][i] - el.box[0][i];
    const j = k === 0 ? 2 : k === 2 ? 0 : (span(0) >= span(2) ? 0 : 2);
    p[k] = v;
    p[j] = el.box[0][j] + frac * (el.box[1][j] - el.box[0][j]);
    return p;
  };
  await page.keyboard.press('Escape');
  await page.mouse.click(...(await page.evaluate((p) => window.viewer.project(p), onFace(0.08))));
  assert.equal((await state(page)).selected, wall);
  await page.click('#pk-cut');
  const mid = await page.evaluate((p) => window.viewer.project(p), onFace(0.92));
  const [h] = await page.evaluate(() => window.viewer.handles());
  assert.ok(Math.hypot(mid[0] - h.at[0], mid[1] - h.at[1]) > 30, 'checking away from the arrow');

  // move it through the element: clicking there no longer finds it
  // a whole number of the slider's 0.01 m steps, past the far side of the element
  const through = Math.ceil((el.box[1][k] - el.box[0][k]) * 100) / 100 + 0.5;
  await page.locator('#cut-list input[type="range"]').fill(String(through));
  c = await cutState(page);
  assert.ok(Math.abs(c.planes[0].offset - through) < 1e-6);
  assert.match(await page.textContent('#cut-list output'), /^\+\d+\.\d{3} m$/);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.mouse.click(...mid);
  assert.notEqual((await state(page)).selected, wall, 'the cut-away element is not picked');

  // Flip keeps the other side: the element is back
  await page.click('#cut-list [data-a="flip"]');
  c = await cutState(page);
  assert.ok(Math.abs(c.planes[0].offset + through) < 1e-6);
  await page.keyboard.press('Escape');
  await page.mouse.click(...mid);
  assert.equal((await state(page)).selected, wall);

  await page.click('#cut-list [data-a="remove"]');
  assert.equal((await cutState(page)).planes.length, 0);
  assert.ok(await page.isHidden('#cuts'));
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Cut: dragging the arrow moves the plane and does not orbit', async () => {
  const { page } = await open();
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.55);
  await page.click('#pk-cut');
  const ref = (await els(page))[0].id;
  const before = await page.evaluate((id) => window.viewer.screenPoint(id), ref);
  const [h] = await page.evaluate(() => window.viewer.handles());
  await page.mouse.move(...h.at);
  await page.mouse.down();
  await page.mouse.move(h.at[0] + 50, h.at[1] - 30, { steps: 5 });
  await page.mouse.move(h.at[0] + 100, h.at[1] - 60, { steps: 5 });
  await page.mouse.up();
  const c = await cutState(page);
  assert.ok(Math.abs(c.planes[0].offset) > 0.5, `moved ${c.planes[0].offset}`);
  assert.deepEqual(await page.evaluate((id) => window.viewer.screenPoint(id), ref), before, 'the camera did not move');
  await page.close();
});

test('Cut: Box cut around an element; arrows resize the box; Remove all', async () => {
  const { page, errors } = await open();
  const column = (await els(page)).find((e) => e.category === 'Structural Columns');
  await selectById(page, column.id);
  await page.click('#pick .pk-more[data-act="cut"]');
  assert.deepEqual(await page.$$eval('#pk-menu button', (b) => b.map((x) => x.textContent)), ['Add cut', 'Box cut']);
  await page.click('#pk-menu [data-scope="box"]');
  let c = await cutState(page);
  for (let k = 0; k < 3; k++) {
    assert.ok(c.box[0][k] < column.box[0][k] && c.box[1][k] > column.box[1][k], `box contains the column on axis ${k}`);
    assert.ok(column.box[0][k] - c.box[0][k] < 1, 'only a little bigger');
  }
  assert.equal((await page.evaluate(() => window.viewer.handles())).length, 6);
  assert.match(await page.textContent('#cut-list'), /Box/);

  // drag the top arrow up
  await page.waitForTimeout(100);
  const top = (await page.evaluate(() => window.viewer.handles())).find((h) => h.axis === 'y' && h.side === 'max');
  const ref = await page.evaluate((id) => window.viewer.screenPoint(id), column.id);
  await page.mouse.move(...top.at);
  await page.mouse.down();
  await page.mouse.move(top.at[0], top.at[1] - 40, { steps: 8 });
  await page.mouse.up();
  const after = await cutState(page);
  assert.ok(after.box[1][1] > c.box[1][1] + 0.1, `top moved up: ${c.box[1][1]} -> ${after.box[1][1]}`);
  assert.deepEqual(after.box[0], c.box[0], 'the other faces stay');
  assert.deepEqual(await page.evaluate((id) => window.viewer.screenPoint(id), column.id), ref, 'no orbit while dragging');

  await page.click('#cut-clear');
  c = await cutState(page);
  assert.deepEqual([c.planes.length, c.box], [0, null]);
  assert.equal((await page.evaluate(() => window.viewer.handles())).length, 0);
  assert.deepEqual(errors(), []);
  await page.close();
});

// ---------- measure ----------
/** Screen point a few pixels inside a corner of an element's top face, towards the face centre. */
async function nearCorner(page, corner, centre) {
  const [c, m] = await Promise.all([corner, centre].map((p) => page.evaluate((q) => window.viewer.project(q), p)));
  const d = Math.hypot(m[0] - c[0], m[1] - c[1]);
  return [c[0] + ((m[0] - c[0]) / d) * 5, c[1] + ((m[1] - c[1]) / d) * 5];
}
const topCorners = (e) => {
  const [lo, hi] = e.box;
  return { a: [lo[0], hi[1], hi[2]], b: [hi[0], hi[1], hi[2]], centre: [(lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2] };
};
const near = (a, b, eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]) < eps);
// the roof slab nearest the viewer, on the right: clear of the cards on the left, also when exploded
const frontRoof = (all) => all.filter((e) => e.category === 'Roofs')
  .sort((p, q) => q.box[1][2] - p.box[1][2] || q.box[0][0] - p.box[0][0])[0];

test('Measure: point to point snaps to corners; the numbers stay real while exploded', async () => {
  const { page, errors } = await open();
  const roof = frontRoof(await els(page));
  let { a, b, centre } = topCorners(roof);
  await page.click('#tb-measure');
  assert.equal((await state(page)).measure.active, true);
  assert.equal(await page.getAttribute('#m-mode [data-mode="distance"]', 'aria-pressed'), 'true');

  const measureCorners = async () => {
    const p = await nearCorner(page, a, centre), q = await nearCorner(page, b, centre);
    await page.mouse.click(...p);
    assert.equal((await state(page)).measure.first, true);
    await page.mouse.move(q[0], q[1] + 1);
    await page.mouse.move(...q);
    await page.waitForSelector('.mlabel.live');
    await page.mouse.click(...q);
    return (await page.evaluate(() => window.viewer.measures())).at(-1);
  };
  let m = await measureCorners();
  assert.equal(m.kind, 'distance');
  const ra = await page.evaluate((p) => window.viewer.toRevit(p), a);
  const rb = await page.evaluate((p) => window.viewer.toRevit(p), b);
  assert.ok(near(m.points[0], ra) && near(m.points[1], rb), `snapped to the corners: ${m.points}`);
  assert.ok(Math.abs(m.d - 10) < 1e-6, `one bay: ${m.d}`);
  assert.equal(m.text.title, '10.000 m');
  assert.equal(m.text.detail, 'ΔX 10.000 · ΔY 0.000 · ΔZ 0.000');
  assert.equal(await page.locator('#m-list li').count(), 1);
  assert.equal(await page.locator('.mlabel.live').count(), 0, 'no rubber band after the second point');

  // explode: the roof rises, its corners are picked where they are drawn, the numbers stay the same
  await page.click('#tb-explode');
  await page.click('#explode-mode [data-mode="vertical"]');
  await page.fill('#explode-amount', '40');
  await page.click('#tb-explode');
  await page.click('#fit');
  await page.waitForTimeout(700);
  if (await page.isHidden('#measure')) await page.click('#tb-measure');
  assert.equal((await state(page)).measure.active, true);
  const moved = (await els(page)).find((e) => e.id === roof.id);
  assert.ok(moved.box[1][1] > roof.box[1][1] + 1, 'the roof was moved up');
  ({ a, b, centre } = topCorners(moved));
  m = await measureCorners();
  assert.ok(near(m.points[0], ra) && near(m.points[1], rb), 'Revit coordinates of the unexploded corners');
  assert.ok(Math.abs(m.d - 10) < 1e-6);

  // Esc drops a first point, then stops measuring
  await page.mouse.click(...(await nearCorner(page, a, centre)));
  assert.equal((await state(page)).measure.first, true);
  await page.keyboard.press('Escape');
  assert.deepEqual([(await state(page)).measure.first, (await state(page)).measure.active], [false, true]);
  await page.keyboard.press('Escape');
  assert.equal((await state(page)).measure.active, false);
  assert.ok(await page.isHidden('#measure'));
  // the measurements stay on screen
  assert.equal(await page.locator('#marks .mlabel').count(), 2);
  await page.click('#tb-measure');
  await page.click('#m-clear');
  assert.equal((await page.evaluate(() => window.viewer.measures())).length, 0);
  assert.equal(await page.locator('#marks .mlabel').count(), 0);
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Measure: position marker gives survey coordinates', async () => {
  const { page, errors } = await open();
  const roof = frontRoof(await els(page));
  const { a, centre } = topCorners(roof);
  await page.click('#tb-measure');
  await page.click('#m-mode [data-mode="point"]');
  await page.mouse.click(...(await nearCorner(page, a, centre)));
  const p = (await page.evaluate(() => window.viewer.measures()))[0];
  assert.equal(p.kind, 'point');
  // Revit internal: the synthetic building's grid, 11985 + 10 k and 7985 + 10 k; roof top at 16 m
  assert.ok([11985, 11995, 12005, 12015].some((x) => Math.abs(p.at[0] - x) < 1e-4), `X ${p.at[0]}`);
  assert.ok([7985, 7995, 8005, 8015].some((y) => Math.abs(p.at[1] - y) < 1e-4), `Y ${p.at[1]}`);
  assert.ok(Math.abs(p.at[2] - 16) < 1e-4, `Z ${p.at[2]}`);
  // survey: the model's shared coordinates put the internal origin at E 6 600 000, N 4 700 000, 100 m
  assert.ok(near(p.shared, [6600000 + p.at[0], 4700000 + p.at[1], 100 + p.at[2]]), `survey ${p.shared}`);
  assert.match(await page.textContent('#marks .mpos'), /^E 6,61\d,\d{3}\.\d{3}\nN 4,70\d,\d{3}\.\d{3}\nZ 116\.000$/);
  assert.equal(p.text.title, 'Position (survey)');
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Measure: the laser measures along the clicked surface to its edges, its thickness and the clear distance', async () => {
  const { page, errors } = await open();
  const all = await els(page);
  // hide the roofs: the top floor slabs are open to the sky
  await selectById(page, frontRoof(all).id);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('h');
  await page.keyboard.press('c');
  assert.equal((await els(page)).filter((e) => e.category === 'Roofs' && e.shown).length, 0);
  await page.click('#fit');
  await page.waitForTimeout(700);
  await page.click('#tb-measure');
  await page.click('#m-mode [data-mode="laser"]');
  const lasers = async () => (await page.evaluate(() => window.viewer.measures())).filter((m) => m.kind === 'laser');

  // a top floor slab, clicked in the middle of its top: 10 × 10 m, 30 cm thick, nothing above
  const floorTop = Math.max(...all.filter((x) => x.category === 'Floors').map((x) => x.box[1][1]));
  const floors = all.filter((e) => e.category === 'Floors' && Math.abs(e.box[1][1] - floorTop) < 1e-4);
  let laser = null;
  for (const f of floors) {
    const mid = [(f.box[0][0] + f.box[1][0]) / 2, f.box[1][1], (f.box[0][2] + f.box[1][2]) / 2];
    await page.mouse.click(...(await page.evaluate((q) => window.viewer.project(q), mid)));
    laser = (await lasers()).at(-1);
    if (laser && Math.abs(laser.origin[2] - 12) < 1e-4) break;
    laser = null;
  }
  assert.ok(laser, 'a laser from the top of a top floor slab');
  const { along, thickness, clear } = laser.info;
  assert.deepEqual(along.map((x) => x.name), ['length', 'width']);
  for (const x of along) assert.ok(Math.abs(x.span - 10) < 1e-4, `${x.name} across the slab: ${x.span}`);
  assert.ok(Math.abs(thickness - 0.3) < 1e-4, `thickness ${thickness}`);
  assert.equal(clear, null, 'roofs hidden: nothing above');
  // the ends along the slab are drawn on its top face, at its edges
  const ends = laser.points.slice(1).filter((q) => Math.abs(q[2] - 12) < 1e-4);
  assert.equal(ends.length, 4);
  assert.match(laser.text.detail, /^length 10\.000 · width 10\.000 · thickness 0\.300 · clear — m$/);

  // a wall on the west side, clicked in the middle of its outer face: 25 cm thick, 3.70 m high,
  // 9.50 m between the columns at its ends, nothing in front
  const wall = all.filter((e) => e.category === 'Walls' && Math.abs(e.box[0][0] - Math.min(...all.map((x) => x.box[0][0]))) < 1e-4)
    .sort((p, q) => q.box[1][1] - p.box[1][1])[0];
  const face = [wall.box[0][0], (wall.box[0][1] + wall.box[1][1]) / 2, (wall.box[0][2] + wall.box[1][2]) / 2];
  await page.mouse.click(...(await page.evaluate((q) => window.viewer.project(q), face)));
  const w = (await lasers()).at(-1);
  assert.notEqual(w, laser, 'a second laser');
  assert.deepEqual(w.info.along.map((x) => x.name), ['length', 'height']);
  assert.ok(Math.abs(w.info.thickness - 0.25) < 1e-4, `wall thickness ${w.info.thickness}`);
  assert.ok(Math.abs(w.info.along[1].span - 3.7) < 1e-4, `wall height ${w.info.along[1].span}`);
  assert.ok(Math.abs(w.info.along[0].span - 9.5) < 1e-4, `between the columns ${w.info.along[0].span}`);
  assert.equal(w.info.clear, null);
  // one total per direction on screen
  assert.ok(await page.locator('#marks .mlabel', { hasText: /^width 10.000$/ }).count() >= 1);

  // the footing turned 25° to the grid: measured along its own sides, 3 x 1.5 m, 1.2 m deep
  const pad = all.find((e) => e.id === 700100);
  const top = [(pad.box[0][0] + pad.box[1][0]) / 2, pad.box[1][1], (pad.box[0][2] + pad.box[1][2]) / 2];
  await page.mouse.click(...(await page.evaluate((q) => window.viewer.project(q), top)));
  const r = (await lasers()).at(-1);
  assert.deepEqual(r.info.along.map((x) => x.name), ['length', 'width']);
  assert.ok(Math.abs(r.info.along[0].span - 3) < 1e-4, `length ${r.info.along[0].span}`);
  assert.ok(Math.abs(r.info.along[1].span - 1.5) < 1e-4, `width ${r.info.along[1].span}`);
  assert.ok(Math.abs(r.info.thickness - 1.2) < 1e-4, `thickness ${r.info.thickness}`);
  assert.equal(await page.locator('#m-list li').count(), (await lasers()).length, 'one row per laser');
  assert.deepEqual(errors(), []);
  await page.close();
});


const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('panels do not overlap the inspect panel (desktop and phone)', async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 700 }, { width: 375, height: 812 }]) {
    const { page } = await open({ viewport });
    await page.click('#tb-explode');
    await page.click('#tb-colour');
    await page.click('#c-quick [data-field="Type"]');
    await page.click('#tb-filter');
    await page.locator('#f-list button').first().click();
    await page.waitForSelector('#panel:not([hidden])');
    const side = await page.locator('#side').boundingBox();
    const filterBox = await page.locator('#filter').boundingBox();
    const colourBox = await page.locator('#colour').boundingBox();
    const panelBox = await page.locator('#panel').boundingBox();
    assert.ok(!overlap(filterBox, panelBox), `${viewport.width}px: filter overlaps the inspect panel`);
    assert.ok(!overlap(colourBox, panelBox), `${viewport.width}px: colour overlaps the inspect panel`);
    assert.ok(!overlap(side, panelBox), `${viewport.width}px: tools overlap the inspect panel`);
    if (viewport.width > 640) {
      const bar = await page.locator('#pick').boundingBox();
      assert.ok(bar, `${viewport.width}px: the Hide / Isolate bar shows`);
      assert.ok(!overlap(bar, panelBox), `${viewport.width}px: the Hide / Isolate bar overlaps the inspect panel`);
      assert.ok(bar.x >= 0 && bar.y >= 0 && bar.x + bar.width <= viewport.width && bar.y + bar.height <= viewport.height);
    } else {
      assert.deepEqual(await page.$$eval('#side section', (s) => s.filter((x) => !x.hidden).map((x) => x.id)), ['filter'],
        'phones: one tool panel at a time');
      assert.ok(await page.isHidden('#pick'), 'phones: no floating bar');
      assert.ok(await page.isVisible('#panel .pactions'), 'phones: Hide / Isolate in the sheet');
      await page.click('#panel .pk-more[data-act="isolate"]');
      const menu = await page.locator('#pk-menu').boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height, 'menu on screen');
      await page.click('#pk-menu [data-scope="element"]');
      assert.equal((await state(page)).isolated, 1);
    }
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${viewport.width}px: scrollWidth ${sw} > clientWidth ${cw}`);
    await page.close();
  }
});

test('phone layout has no horizontal scroll', async () => {
  const { page } = await open({ viewport: { width: 375, height: 812 } });
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, `scrollWidth ${sw} > clientWidth ${cw}`);
  await page.close();
});
