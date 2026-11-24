// Opens the packaged synthetic model (tests/out/synthetic.html, written by the C#
// tests) in headless Chromium from file://, as a user double-clicking the file would.
//   dotnet test ../tests/RevitThreeExport.Tests && node --test test/viewer.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'tests', 'out');
const html = path.join(out, 'synthetic.html');
const stats = JSON.parse(fs.readFileSync(path.join(out, 'synthetic.stats.json'), 'utf8'));
// software WebGL in headless Chromium
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

let browser;
before(async () => { browser = await chromium.launch({ args }); });
after(async () => { await browser?.close(); });

async function open(viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // the offline file must not need the network (fonts may fail; they fall back)
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(html).href);
  await page.waitForSelector('#status', { state: 'hidden', timeout: 60000 });
  const fontErrors = (e) => !/fonts\.googleapis|ERR_FAILED|net::/.test(e);
  return { page, errors: () => errors.filter(fontErrors) };
}

test('loads the gzip+base64 model with no console errors', async () => {
  const { page, errors } = await open();
  assert.deepEqual(errors(), []);
  assert.equal(await page.textContent('#doc-title'), 'Sintetički model');
  const cats = await page.textContent('#doc-cats');
  assert.match(cats, new RegExp(`^${stats.elements} elements: `));
  for (const [c, n] of Object.entries(stats.perCategory)) assert.ok(cats.includes(`${c} ${n}`), `${c} ${n} in "${cats}"`);
  assert.match(await page.textContent('#doc-meta'), /Revit view "Export" · exported 2026-11-24 12:00/);
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

test('phone layout has no horizontal scroll', async () => {
  const { page } = await open({ width: 375, height: 812 });
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, `scrollWidth ${sw} > clientWidth ${cw}`);
  await page.close();
});
