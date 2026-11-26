// Opens the packaged synthetic model (tests/out/synthetic.html, written by the C#
// tests) in headless Chromium from file://, as a user double-clicking the file would.
//   dotnet test ../tests/RevitThreeExport.Tests && node --test test/viewer.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices } from 'playwright';
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

// ---------- quantity take-off ----------
const qtoOf = (page) => page.evaluate(() => window.viewer.qto());
const closeTo = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const exact = (d, name) => d.paramNumbers?.[name] ?? d.typeParamNumbers?.[name];
const sumOf = (ds, name) => Number(ds.reduce((s, d) => s + (exact(d, name) ?? 0), 0).toPrecision(12));

/** Files of a zip with stored entries: name -> text. */
function unzip(bytes) {
  const out = {};
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    const size = bytes.readUInt32LE(at + 18), n = bytes.readUInt16LE(at + 26);
    out[bytes.subarray(at + 30, at + 30 + n).toString('utf8')] = bytes.subarray(at + 30 + n, at + 30 + n + size).toString('utf8');
    at += 30 + n + size;
  }
  return out;
}

test('Quantities: exact totals by category and type; follows the filter; columns, grouping and sorting', async () => {
  const { page, errors } = await open();
  await page.click('#tb-qto');
  await page.waitForSelector('#qto:not([hidden])');
  let q = await qtoOf(page);
  assert.deepEqual(q.head, ['Category', 'Type', 'Count', 'Volume (m³)', 'Area (m²)']);
  const total = q.rows.at(-1);
  assert.equal(total.kind, 'total');
  assert.equal(total.n, data.length);
  closeTo(total.cells[3], sumOf(data, 'Volume'), 'volume total');
  closeTo(total.cells[4], sumOf(data, 'Area'), 'area total');
  // the rounded text ("1 m²" for 0.96 m²) would add up to something else
  const textSum = data.reduce((s, d) => s + parseFloat(d.params.Area), 0);
  assert.ok(Math.abs(textSum - total.cells[4]) > 1, `exact ${total.cells[4]}, text ${textSum}`);
  // every group row: its elements and their exact sums
  for (const r of q.rows.filter((x) => x.kind === 'group')) {
    const ds = data.filter((d) => d.category === r.cells[0] && d.type === r.cells[1]);
    assert.equal(r.n, ds.length, `${r.cells[0]} / ${r.cells[1]}`);
    closeTo(r.cells[3], sumOf(ds, 'Volume'), `${r.cells[1]} volume`);
  }
  const gm = q.rows.find((x) => x.kind === 'subtotal' && x.cells[0] === 'Generic Models');
  assert.equal(gm.n, data.filter((d) => d.category === 'Generic Models').length, 'subtotal of a category with two types');
  assert.match(await page.textContent('#q-table tfoot'), /Total/);

  // the filter narrows what is counted; All counts everything
  await page.click('#tb-filter');
  await setRule(page, 'Category', 'eq', 'Walls');
  const walls = data.filter((d) => d.category === 'Walls');
  q = await qtoOf(page);
  assert.equal(q.rows.at(-1).n, walls.length);
  assert.match(await page.textContent('#q-count'), new RegExp(`^${walls.length} of ${data.length} elements`));
  await page.click('#q-scope [data-scope="all"]');
  assert.equal((await qtoOf(page)).rows.at(-1).n, data.length);
  await page.click('#q-scope [data-scope="visible"]');
  await page.click('#f-clear');
  assert.equal((await qtoOf(page)).rows.at(-1).n, data.length);

  // a type parameter column (exact values); unknown names are refused
  await page.fill('#q-col-add', 'width');
  await page.press('#q-col-add', 'Enter');
  q = await qtoOf(page);
  assert.deepEqual(q.head.slice(2), ['Count', 'Volume (m³)', 'Area (m²)', 'Width']);
  closeTo(q.rows.at(-1).cells[5], sumOf(data, 'Width'), 'width total');
  await page.fill('#q-col-add', 'No such parameter');
  await page.press('#q-col-add', 'Enter');
  assert.equal((await qtoOf(page)).head.length, 6);
  assert.equal(await page.$eval('#q-col-add', (i) => i.validity.valid), false);
  await page.fill('#q-col-add', '');
  // Sum -> Max
  await page.selectOption('#q-cols select[data-c="2"]', 'max');
  closeTo((await qtoOf(page)).rows.at(-1).cells[5], Math.max(...data.map((d) => exact(d, 'Width'))), 'width max');
  await page.click('#q-cols button[data-c="2"]');
  assert.deepEqual((await qtoOf(page)).head.slice(3), ['Volume (m³)', 'Area (m²)']);

  // group by Level too, then by Category alone
  await page.fill('#q-group-add', 'Level');
  await page.press('#q-group-add', 'Enter');
  assert.deepEqual((await qtoOf(page)).head.slice(0, 3), ['Category', 'Type', 'Level']);
  await page.click('#q-groups button[data-g="2"]');
  await page.click('#q-groups button[data-g="1"]');
  q = await qtoOf(page);
  assert.deepEqual(q.head, ['Category', 'Count', 'Volume (m³)', 'Area (m²)']);
  assert.deepEqual(q.rows.filter((r) => r.kind === 'group').map((r) => r.cells[0]),
    [...new Set(data.map((d) => d.category))].sort((a, b) => a.localeCompare(b)));

  // sort: biggest volume first, then smallest first, then back to names
  const volumes = async () => (await qtoOf(page)).rows.filter((r) => r.kind === 'group').map((r) => r.cells[2]);
  await page.click('#q-table th[data-key="c0"] button');
  assert.equal(await page.getAttribute('#q-table th[data-key="c0"]', 'aria-sort'), 'descending');
  let v = await volumes();
  assert.deepEqual(v, [...v].sort((a, b) => b - a));
  await page.click('#q-table th[data-key="c0"] button');
  v = await volumes();
  assert.deepEqual(v, [...v].sort((a, b) => a - b));
  await page.click('#q-table th[data-key="c0"] button');
  assert.equal(await page.getAttribute('#q-table th[data-key="c0"]', 'aria-sort'), 'none');
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Quantities: rows show, isolate and hide their elements; one row per element selects it', async () => {
  const { page, errors } = await open();
  await page.click('#tb-qto');
  const walls = data.filter((d) => d.category === 'Walls');
  const wallRow = page.locator('#q-table tbody tr', { hasText: 'Obloga od Kulira' });
  // a row highlights its elements and zooms to them; again, or Esc, turns that off
  await wallRow.click();
  assert.equal((await qtoOf(page)).marked, 1);
  assert.equal(await wallRow.getAttribute('class'), 'q-group on');
  await page.keyboard.press('Escape');
  assert.equal((await qtoOf(page)).marked, 0);
  const subtotal = page.locator('#q-table tbody tr.q-subtotal', { hasText: 'Walls' });
  await subtotal.click();
  assert.equal((await qtoOf(page)).marked, walls.length);
  await subtotal.click();
  assert.equal((await qtoOf(page)).marked, 0);

  // Isolate from the row: only those elements show, and the table counts them alone
  await subtotal.hover();
  await subtotal.locator('button[data-a="isolate"]').click();
  assert.equal((await state(page)).isolated, walls.length);
  assert.equal(await shownCount(page), walls.length);
  assert.equal((await qtoOf(page)).rows.at(-1).n, walls.length);
  await page.click('#vis-all');
  // Hide from the row
  const floors = page.locator('#q-table tbody tr', { hasText: 'Ploča 30 cm' });
  await floors.hover();
  await floors.locator('button[data-a="hide"]').click();
  const nFloors = data.filter((d) => d.category === 'Floors').length;
  assert.equal(await shownCount(page), data.length - nFloors);
  await page.click('#vis-all');

  // one row per element: Element ID column; a row selects its element
  await page.check('#q-itemize');
  const q = await qtoOf(page);
  assert.deepEqual(q.head.slice(0, 3), ['Category', 'Type', 'Element ID']);
  assert.equal(q.rows.filter((r) => r.kind === 'item').length, data.length);
  await page.locator('#q-table tbody tr', { hasText: '843064' }).click();
  assert.equal((await state(page)).selected, 843064);
  assert.ok(await page.isVisible('#panel'));
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Quantities: formula columns; Excel and CSV files; the setup is remembered', async () => {
  const { page, errors } = await open();
  await page.click('#tb-qto');
  await page.click('#q-formula');
  await page.fill('#q-fname', 'Concrete (kg)');
  await page.fill('#q-fexpr', '[Nope] * 2');
  await page.click('#q-fform button[type="submit"]');
  assert.match(await page.textContent('#q-ferr'), /Not a parameter in this model: Nope/);
  await page.fill('#q-fexpr', '[Volume] * 2,4 *');
  await page.click('#q-fform button[type="submit"]');
  assert.match(await page.textContent('#q-ferr'), /ends too early/);
  await page.fill('#q-fexpr', '[volume] * 2400');
  await page.click('#q-fform button[type="submit"]');
  assert.ok(await page.isHidden('#q-fform'));
  let q = await qtoOf(page);
  assert.equal(q.head.at(-1), 'Concrete (kg)');
  closeTo(q.rows.at(-1).cells.at(-1), sumOf(data, 'Volume') * 2400, 'concrete');
  // change it from its chip
  await page.click('#q-cols button[data-edit]');
  await page.fill('#q-fexpr', '[Volume] * 2500');
  await page.click('#q-fform button[type="submit"]');
  q = await qtoOf(page);
  closeTo(q.rows.at(-1).cells.at(-1), sumOf(data, 'Volume') * 2500, 'concrete, changed');
  assert.equal(q.head.length, 6);

  // Excel: numbers as numbers, a title block, the formula written down
  const [xl] = await Promise.all([page.waitForEvent('download'), page.click('#q-xlsx')]);
  assert.equal(xl.suggestedFilename(), 'Sintetički model_Export_quantities.xlsx');
  const files = unzip(fs.readFileSync(await xl.path()));
  const ws = files['xl/worksheets/sheet1.xml'];
  assert.ok(ws, 'the sheet is in the workbook');
  assert.match(ws, /<t>Quantities – Sintetički model<\/t>/);
  assert.match(ws, /<t>Concrete \(kg\) = \[Volume\] \* 2500<\/t>/);
  assert.ok(ws.includes(`<v>${q.rows.at(-1).cells[3]}</v>`), 'the volume total as a number');
  assert.ok(ws.includes(`<v>${data.length}</v>`), 'the count');
  // CSV
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#q-csv')]);
  assert.equal(csv.suggestedFilename(), 'Sintetički model_Export_quantities.csv');
  const text = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).trim().split('\r\n');
  assert.equal(lines[0], ['Category', 'Type', 'Count', 'Volume (m³)', 'Area (m²)', 'Concrete (kg)'].join(','));
  assert.equal(lines.length, q.rows.length + 1);
  assert.match(lines.at(-1), new RegExp(`^Total,,${data.length},`));

  // the columns and grouping are remembered for this model
  await page.reload();
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  await page.click('#tb-qto');
  assert.deepEqual((await qtoOf(page)).head, ['Category', 'Type', 'Count', 'Volume (m³)', 'Area (m²)', 'Concrete (kg)']);
  assert.deepEqual(errors(), []);
  await page.close();
});

test('Quantities: the table fits beside the inspect panel and under the tools; resizable; phones', async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 700 }, { width: 375, height: 812 }]) {
    const { page } = await open({ viewport });
    await page.click('#tb-qto');
    const qbox = () => page.locator('#qto').boundingBox();
    let box = await qbox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${viewport.width}px: on screen`);
    const tools = await page.locator('#tools').boundingBox();
    assert.ok(!overlap(tools, box), `${viewport.width}px: the tools overlap the table`);
    assert.ok(await page.isHidden('#hint'), 'the hint makes room');
    if (viewport.width > 640) {
      assert.equal((await page.$eval('#q-bar', (b) => b.hidden)), false, 'grouping and columns shown');
      await page.click('#tb-filter');
      assert.ok(!overlap(await page.locator('#filter').boundingBox(), box), `${viewport.width}px: the filter overlaps the table`);
      // inspect an element (picked from the table: the middle of the view is under the filter at 800 px)
      await page.check('#q-itemize');
      await page.locator('#q-table tbody tr.q-item').first().click();
      await page.waitForSelector('#panel:not([hidden])');
      box = await qbox();
      assert.ok(!overlap(await page.locator('#panel').boundingBox(), box), `${viewport.width}px: the table overlaps the inspect panel`);
      const bar = await page.locator('#pick').boundingBox();
      assert.ok(!overlap(bar, box), `${viewport.width}px: the Hide / Isolate bar overlaps the table`);
      // drag the top edge up: taller, and remembered
      const h0 = box.height;
      const grip = await page.locator('#q-grip').boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 100, { steps: 4 });
      await page.mouse.up();
      const h1 = (await qbox()).height;
      assert.ok(Math.abs(h1 - (h0 + 100)) <= 2, `resized: ${h0} -> ${h1}`);
    } else {
      assert.equal((await page.$eval('#q-bar', (b) => b.hidden)), true, 'phones: the table gets the room');
      await page.click('#q-setup');
      assert.equal((await page.$eval('#q-bar', (b) => b.hidden)), false);
      await page.click('#tb-filter');
      assert.ok(await page.isHidden('#qto'), 'phones: one tool panel at a time');
      await page.click('#tb-qto');
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

test('toolbar buttons have icons; phones show the icons only, on one row', async () => {
  const { page, errors } = await open();
  const tools = page.locator('#tools .tool');
  const n = await tools.count();
  assert.equal(n, 6);
  for (let i = 0; i < n; i++) assert.equal(await tools.nth(i).locator('svg').count(), 1, `tool ${i} has an icon`);
  assert.ok(await page.isVisible('#tb-filter .tl'), 'wide screens: labels shown');
  for (const id of ['#fit', '#vis-undo', '#vis-all', '#q-xlsx', '#q-csv']) assert.equal(await page.locator(`${id} svg`).count(), 1, `${id} has an icon`);
  assert.deepEqual(errors(), []);
  await page.close();

  const phone = (await open({ viewport: { width: 375, height: 812 } })).page;
  const box = await phone.locator('#tools').boundingBox();
  assert.ok(box.height < 56, `one row of tools: ${box.height}px`);
  const label = await phone.locator('#tb-filter .tl').boundingBox();
  assert.ok(label.width <= 1, 'phones: the label is only for screen readers');
  // the names stay
  for (const name of ['Explode', 'Filter', 'Colour', 'Measure', 'Quantities']) {
    assert.equal(await phone.getByRole('button', { name, exact: true }).count(), 1, `button named ${name}`);
  }
  await phone.close();
});

test('model information folds away to the title, remembered; folded at first on phones', async () => {
  const { page, errors } = await open();
  assert.ok(await page.isVisible('#doc-meta'));
  const top0 = (await page.locator('#tools').boundingBox()).y;
  await page.click('#head-toggle');
  assert.ok(await page.isHidden('#doc-meta'));
  assert.equal(await page.getAttribute('#head-toggle', 'aria-expanded'), 'false');
  await page.waitForFunction((y) => document.querySelector('#tools').getBoundingClientRect().y < y - 20, top0);
  await page.reload();
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  assert.ok(await page.isHidden('#doc-meta'), 'remembered');
  await page.click('#head-toggle');
  assert.ok(await page.isVisible('#doc-meta'));
  assert.deepEqual(errors(), []);
  await page.close();

  const phone = (await open({ viewport: { width: 375, height: 812 } })).page;
  assert.ok(await phone.isHidden('#doc-meta'), 'phones: folded at first');
  assert.equal(await phone.textContent('#doc-title'), 'Sintetički model');
  await phone.close();
});

test('phones: the inspect sheet closes with ×, a swipe down and the Back button; × stays in view', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(html).href);
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  await page.waitForSelector('#status', { state: 'hidden' });
  // an element low on the screen: where the sheet's buttons appear after the tap
  const vp = page.viewportSize();
  let target = null;
  for (const e of await els(page)) {
    const [x, y] = await page.evaluate((id) => window.viewer.screenPoint(id), e.id);
    if (e.category === 'Walls' && y > vp.height * 0.6 && y < vp.height - 40 && x > 40 && x < vp.width - 40) { target = [x, y]; break; }
  }
  assert.ok(target, 'a wall low on the screen');
  const openSheet = async () => {
    await page.touchscreen.tap(...target);
    await page.waitForSelector('#panel:not([hidden])');
    // the click that follows the tap must not press a button of the sheet
    const st = await page.evaluate(() => window.viewer.state());
    assert.equal(st.hidden, 0, 'nothing hidden by the tap');
    assert.equal(st.isolated, null, 'nothing isolated by the tap');
  };
  const closed = () => page.waitForSelector('#panel', { state: 'hidden', timeout: 3000 });

  // × is big enough and stays in view when the properties are scrolled to the end
  await openSheet();
  await page.$eval('#panel .p-body', (b) => { for (const d of b.querySelectorAll('details')) d.open = true; b.scrollTop = b.scrollHeight; });
  const x = await page.locator('#close').boundingBox();
  assert.ok(x.width >= 44 && x.height >= 44, `× is ${x.width}×${x.height}`);
  assert.equal(await page.evaluate(([cx, cy]) => document.elementFromPoint(cx, cy)?.id, [x.x + x.width / 2, x.y + x.height / 2]), 'close');
  await page.touchscreen.tap(x.x + x.width / 2, x.y + x.height / 2);
  await closed();

  // a short drag on the header puts the sheet back; a long one closes it
  const drag = async (dy) => {
    const h = await page.locator('#panel .p-head').boundingBox();
    const sx = h.x + h.width / 2, sy = h.y + 8;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx, sy + dy, { steps: 8 });
    await page.mouse.up();
  };
  await openSheet();
  await drag(30);
  assert.ok(await page.isVisible('#panel'), 'a short drag does not close');
  assert.equal(await page.$eval('#panel', (p) => p.style.transform), '');
  await drag(140);
  await closed();

  // the Back button closes it, and only it: the page stays
  await openSheet();
  await page.goBack();
  await closed();
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('frames are drawn only when something changes, and every change is drawn', async () => {
  const { page, errors } = await open({ reducedMotion: 'no-preference' });
  const frames = async () => (await page.evaluate(() => window.viewer.stats())).frames;
  // until no frame has been drawn for 400 ms (orbit damping runs on for about a second)
  const settle = async () => {
    let last = await frames(), since = Date.now();
    const t0 = Date.now();
    while (Date.now() - since < 400) {
      assert.ok(Date.now() - t0 < 4000, 'the view never comes to rest');
      await page.waitForTimeout(50);
      const n = await frames();
      if (n !== last) { last = n; since = Date.now(); }
    }
  };
  const shot = () => page.locator('#viewport canvas').screenshot();
  await settle();
  // still: no frames at all
  let f0 = await frames();
  await page.waitForTimeout(1000);
  assert.equal(await frames(), f0, 'a still model draws nothing');

  // orbiting draws, then stops
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 200 + i * 15, box.y + 200);
  await page.mouse.up();
  await settle();
  const f1 = await frames();
  assert.ok(f1 > f0 + 3, `orbiting drew ${f1 - f0} frames`);
  assert.equal((await page.evaluate(() => window.viewer.stats())).pixelRatio, 1, 'the last frame is at full resolution');

  // a filter applied after a typing pause is drawn
  const before = await shot();
  await page.click('#tb-filter');
  await page.fill('#f-search', 'Roofs');
  await page.waitForTimeout(600);
  assert.ok(!(await shot()).equals(before), 'the filtered model is drawn');
  // explode animates and stops
  await page.fill('#f-search', '');
  await page.click('#tb-explode');
  await settle();
  const f2 = await frames();
  await page.locator('#explode-amount').fill('60');
  await settle();
  const f3 = await frames();
  assert.ok(f3 > f2 + 3, `explode drew ${f3 - f2} frames`);
  // a theme change redraws the grid
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  assert.ok(await frames() > f3, 'the theme change is drawn');
  assert.deepEqual(errors(), []);
  await page.close();
});

test('big model: the spatial index is built after loading and gives the same hits', async () => {
  const stress = path.join(out, 'stress.html');
  const hitsOf = async (noBvh) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    if (noBvh) await page.addInitScript(() => { window.__rteNoBvh = true; });
    await page.route(/^https?:/, (route) => route.abort());
    await page.goto(pathToFileURL(stress).href, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.viewer.ready), true);
    await page.waitForSelector('#status', { state: 'hidden', timeout: 120000 });
    if (!noBvh) {
      await page.waitForFunction(() => window.viewer.stats().bvh.pending === 0, null, { timeout: 60000 });
      assert.ok((await page.evaluate(() => window.viewer.stats().bvh.built)) >= 5, 'trees built (one per shared geometry)');
    }
    // click a grid of points over the hall (columns, beams, purlins, plates and bolts)
    const box = await page.locator('#viewport canvas').boundingBox();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        await page.mouse.click(box.x + box.width * (0.3 + i * 0.13), box.y + box.height * (0.3 + j * 0.13));
        ids.push(await page.evaluate(() => window.viewer.state().selected));
        await page.keyboard.press('Escape');
      }
    }
    await page.close();
    return ids;
  };
  const withIndex = await hitsOf(false);
  const without = await hitsOf(true);
  assert.ok(withIndex.filter(Boolean).length >= 4, `clicks hit the frame: ${withIndex}`);
  assert.deepEqual(withIndex, without);
});

test('batches: the drawn model follows selection, hide, show all and ghost', async () => {
  const { page, errors } = await open();
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => window.viewer.stats());
  assert.ok(st.calls <= 6, `a few draw calls: ${st.calls}`);
  const meshCount = await page.evaluate(() => window.viewer.elements().reduce((n, e) => n + e.colours.length, 0));
  assert.equal(st.batches.instances, meshCount, 'every mesh is in a batch');
  // a few pixels in the middle of a wall facing the view
  const wall = (await els(page)).find((e) => e.category === 'Walls' && e.id === 843064);
  const [x, y] = await page.evaluate((id) => window.viewer.screenPoint(id), wall.id);
  const clip = { x: Math.round(x) - 3, y: Math.round(y) - 3, width: 6, height: 6 };
  const spot = async () => { await page.waitForTimeout(150); return page.screenshot({ clip }); };
  const plain = await spot();
  await page.mouse.click(x, y);
  assert.ok((await page.evaluate(() => window.viewer.state())).selected, 'an element under the spot');
  assert.ok(!(await spot()).equals(plain), 'the selected element is drawn highlighted');
  await page.keyboard.press('h');
  await page.keyboard.press('h');
  assert.equal((await page.evaluate(() => window.viewer.state())).hidden, 1);
  const hidden = await spot();
  assert.ok(!hidden.equals(plain), 'the hidden element is not drawn');
  await page.click('#vis-all');
  assert.ok((await spot()).equals(plain), 'shown again, as before');
  // ghost: everything but the roofs faint
  await page.click('#tb-filter');
  await page.click('#f-mode button[data-mode="ghost"]');
  await page.fill('#f-search', 'Roofs');
  await page.waitForTimeout(400);
  assert.equal((await page.evaluate(() => window.viewer.stats())).batches.ghost, true);
  const ghosted = await spot();
  assert.ok(!ghosted.equals(plain) && !ghosted.equals(hidden), 'the ghosted wall is drawn faint');
  await page.fill('#f-search', '');
  await page.waitForTimeout(400);
  assert.ok((await spot()).equals(plain), 'not ghosted any more');
  assert.deepEqual(errors(), []);
  await page.close();
});

test('big model: a few draw calls; tiny parts are left out while the view moves', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(path.join(out, 'stress.html')).href, { timeout: 120000 });
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  await page.waitForSelector('#status', { state: 'hidden', timeout: 120000 });
  await page.waitForFunction(() => window.viewer.stats().lod.done, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const still = await page.evaluate(() => window.viewer.stats());
  assert.ok(still.calls <= 10, `draw calls: ${still.calls}`);
  assert.ok(still.batches.instances > 28000);
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + 600, box.y + 400);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(box.x + 600 + i * 10, box.y + 400);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  }
  const moving = await page.evaluate(() => window.viewer.stats());
  await page.mouse.up();
  assert.ok(moving.triangles < still.triangles * 0.8, `while moving ${moving.triangles} of ${still.triangles} triangles`);
  await page.waitForFunction(() => !document.body.classList.contains('moving'), null, { timeout: 10000 });
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => window.viewer.stats())).triangles, still.triangles, 'all drawn again when still');
  await page.close();
});

test('lighter versions are only drawn: clicks and measurements are the same with them as without', async () => {
  const stress = path.join(out, 'stress.html');
  const run = async (init) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await page.addInitScript(init);
    await page.route(/^https?:/, (route) => route.abort());
    await page.goto(pathToFileURL(stress).href, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.viewer.ready), true);
    await page.waitForSelector('#status', { state: 'hidden', timeout: 120000 });
    await page.waitForFunction(() => { const s = window.viewer.stats(); return s.lod.done; }, null, { timeout: 120000 });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => window.viewer.stats());
    // close up on the middle of a handrail
    const rail = (await els(page)).find((e) => e.category === 'Railings');
    const [[x0, y0, z0], [x1, y1, z1]] = rail.box;
    const along = (t) => [x0 + (x1 - x0) * t, (y0 + y1) / 2, (z0 + z1) / 2];
    await page.evaluate(([a, b]) => window.viewer.fitBox(a, b), [along(0.49).map((v) => v - 0.05), along(0.51).map((v) => v + 0.05)]);
    await page.waitForTimeout(300);
    const p = await page.evaluate((v) => window.viewer.project(v), along(0.495));
    const q = await page.evaluate((v) => window.viewer.project(v), along(0.505));
    await page.mouse.click(...p);
    const hit = await page.evaluate(() => window.viewer.state().selected);
    await page.keyboard.press('Escape');
    await page.click('#tb-measure');
    await page.mouse.click(...p);
    await page.mouse.move(q[0], q[1] + 1);
    await page.mouse.move(...q);
    await page.mouse.click(...q);
    const m = (await page.evaluate(() => window.viewer.measures())).at(-1);
    await page.close();
    return { st, hit, m, rail };
  };
  const coarse = await run(() => { window.__rteLodPx = 1e9; });   // the lightest version everywhere
  const full = await run(() => { window.__rteNoLod = true; });
  assert.ok(coarse.st.batches.lods >= 4, `lighter versions made: ${coarse.st.batches.lods}`);
  assert.ok(coarse.st.triangles < full.st.triangles, `fewer triangles drawn: ${coarse.st.triangles} < ${full.st.triangles}`);
  assert.equal(coarse.hit, coarse.rail.id, 'the click hits the handrail');
  assert.equal(coarse.hit, full.hit);
  assert.ok(coarse.m && full.m, 'measured');
  assert.equal(coarse.m.d, full.m.d);
  assert.deepEqual(coarse.m.points, full.m.points);
});

test('precision: a box 20 km away measures 1234.5 mm and 16 mm exactly', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(path.join(out, 'far.html')).href);
  assert.equal(await page.evaluate(() => window.viewer.ready), true);
  await page.waitForSelector('#status', { state: 'hidden' });
  const far = (await els(page)).find((e) => e.id === 900002);
  const [lo, hi] = far.box;
  await page.click('#tb-measure');
  // frame the box with room on its left, where the measure panel is
  await page.evaluate(([a, b]) => window.viewer.fitBox(a, b), [[lo[0] - 1.6, lo[1], lo[2]], hi]);
  await page.waitForTimeout(300);
  // corners of a face, each clicked a few pixels towards the face's centre (then snapped)
  const measure = async (p, q, centre) => {
    const a = await nearCorner(page, p, centre), b = await nearCorner(page, q, centre);
    await page.mouse.click(...a);
    await page.mouse.move(b[0], b[1] + 1);
    await page.mouse.move(...b);
    await page.mouse.click(...b);
    return (await page.evaluate(() => window.viewer.measures())).at(-1);
  };
  // the long top edge of the face towards the viewer; the short edge of the end facing it
  const long = await measure([lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]]);
  assert.ok(Math.abs(long.d - 1.2345) < 1e-5, `length ${long.d}`);
  assert.ok(Math.abs(long.points[0][0] - 25000) < 1e-6, `20 km from the other box (Revit x 5000 + 20000): ${long.points[0]}`);
  await page.click('#m-clear');   // its dots sit on the corners the next one starts from
  // close up on the end, where the 16 mm is wide enough on screen to pick both corners
  await page.evaluate(([a, b]) => window.viewer.fitBox(a, b), [[lo[0] - 0.06, hi[1] - 0.06, lo[2] - 0.02], [lo[0] + 0.02, hi[1] + 0.02, hi[2] + 0.02]]);
  await page.waitForTimeout(300);
  const thin = await measure([lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]], [lo[0], (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
  assert.ok(Math.abs(thin.d - 0.016) < 1e-5, `thickness ${thin.d}`);
  assert.deepEqual(errors, []);
  await page.close();
});
