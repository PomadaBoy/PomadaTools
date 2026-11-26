// Puts the model of an exported HTML file into the current viewer, without Revit:
//
//   node repack.mjs <old.html> <new.html>
//
// Run `node build.mjs` first: it reads the template from ../src/RevitThreeExport/Resources/viewer.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node repack.mjs <old.html> <new.html>');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, '..', 'src', 'RevitThreeExport', 'Resources', 'viewer.html'), 'utf8');
const old = fs.readFileSync(src, 'utf8');
const model = old.match(/<script id="model-glb"[^>]*data-encoding="gzip-base64"[^>]*>([^<]*)<\/script>/);
if (!model) throw new Error(`${src}: no gzip-base64 model found`);
const title = old.match(/<title>([^<]*)<\/title>/)?.[1] ?? 'Revit model';   // already HTML-escaped
const html = template.split('__TITLE__').join(title).replace('__MODEL_BASE64__', () => model[1]);
fs.writeFileSync(dst, html);
console.log(`${dst}: ${(html.length / 1048576).toFixed(1)} MB`);
