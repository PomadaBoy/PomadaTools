// Speed check for an exported model (not part of the tests):
//
//   node bench.mjs <file.html> [--gpu] [--size 1280x800] [--dpr 1]
//
// Opens the file in headless Chromium and prints how long it takes to load, how many frames
// it draws per second while nothing moves, the time per frame while orbiting, the time a
// click takes to select an element, and the draw calls and triangles of a frame. Without
// --gpu it renders in software (SwiftShader), which behaves like a slow PC.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && !/^\d+(x\d+)?$/.test(a) && !/^[\d.]+$/.test(a));
if (!file) {
  console.error('usage: node bench.mjs <file.html> [--gpu] [--size 1280x800] [--dpr 1]');
  process.exit(2);
}
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const gpu = argv.includes('--gpu');
const [width, height] = opt('--size', '1280x800').split('x').map(Number);
const dpr = Number(opt('--dpr', '1'));

const args = gpu
  ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
await page.route(/^https?:/, (r) => r.abort());
const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const stats = () => page.evaluate(() => window.viewer.stats?.() ?? null);

const t0 = Date.now();
await page.goto(pathToFileURL(path.resolve(file)).href, { timeout: 300000 });
if (!(await page.evaluate(() => window.viewer.ready))) throw new Error('the model did not load');
await page.waitForSelector('#status', { state: 'hidden', timeout: 300000 });
const loadMs = Date.now() - t0;
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const ext = c?.getExtension('WEBGL_debug_renderer_info');
  return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

// let the spatial index and the lighter versions finish (they are made while idle)
await page.waitForFunction(() => { const s = window.viewer.stats?.(); return !s?.bvh || s.lod?.done; }, null, { timeout: 120000 }).catch(() => {});
const readyMs = Date.now() - t0;
// settle, then count the frames drawn while nothing happens
for (let i = 0; i < 10; i++) await nextFrame();
await page.waitForTimeout(800);
const s0 = await stats();
await page.waitForTimeout(2000);
const s1 = await stats();
const idleFps = s0 && s1 ? (s1.frames - s0.frames) / 2 : NaN;

// orbit: drag across the view a few pixels per frame
const box = await page.locator('#viewport canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
const o0 = await stats();
const tOrbit = Date.now();
let steps = 0;
while (Date.now() - tOrbit < 4000 && steps < 120) {
  steps++;
  await page.mouse.move(cx + steps * 3, cy + Math.sin(steps / 8) * 20);
  await nextFrame();
}
const orbitElapsed = Date.now() - tOrbit;
const o1 = await stats();
await page.mouse.up();
const orbitFrames = o0 && o1 ? o1.frames - o0.frames : steps;
const msPerFrame = orbitElapsed / Math.max(orbitFrames, 1);
await page.waitForFunction(() => !document.body.classList.contains('moving'), null, { timeout: 30000 });
await page.waitForTimeout(300);
const still = await stats();

// clicks on elements in view
await page.click('#fit');
await page.waitForTimeout(800);
const ids = await page.evaluate(() => {
  const r = document.querySelector('#viewport canvas').getBoundingClientRect();
  return window.viewer.elements().map((e) => [e.id, window.viewer.screenPoint(e.id)])
    .filter(([, p]) => p && p[0] > r.left + r.width * 0.3 && p[0] < r.right - r.width * 0.3 && p[1] > r.top + r.height * 0.3 && p[1] < r.bottom - r.height * 0.3)
    .slice(0, 400);
});
const clicks = [];
for (let k = 0; k < ids.length && clicks.length < 5; k += Math.max(1, Math.floor(ids.length / 8))) {
  const [, [x, y]] = ids[k];
  const t = Date.now();
  await page.mouse.click(x, y);
  try {
    await page.waitForFunction(() => window.viewer.state().selected !== null, null, { timeout: 10000 });
    clicks.push(Date.now() - t);
  } catch { /* hit the background */ }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}
const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
await browser.close();

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '–');
console.log(`file            ${path.basename(file)}`);
console.log(`renderer        ${gl} (${width}x${height} @${dpr}x)`);
console.log(`load            ${fmt(loadMs)} ms (index and lighter versions ready at ${fmt(readyMs)} ms)`);
console.log(`idle frames     ${fmt(idleFps, 1)} per second`);
console.log(`orbit           ${fmt(msPerFrame)} ms per frame (${orbitFrames} frames in ${orbitElapsed} ms)`);
console.log(`click → select  ${clicks.length ? clicks.map((c) => `${c}`).join(', ') + ' ms' : 'no element hit'}`);
console.log(`a frame         ${still?.calls ?? '–'} draw calls, ${still?.triangles?.toLocaleString('en') ?? '–'} triangles, pixel ratio ${still?.pixelRatio ?? '–'}`);
console.log(`JS heap         ${fmt(heap / 1048576)} MB`);
