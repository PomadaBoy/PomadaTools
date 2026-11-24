// Builds the viewer template that the C# exporter embeds as a resource.
//
//   node build.mjs            -> ../src/RevitThreeExport/Resources/viewer.html
//   node build.mjs out.html   -> somewhere else
//
// The template is one HTML file: CSS, three.js and the viewer bundled in. Two
// placeholders are left for HtmlPackager to fill at export time:
//   __TITLE__         document name (HTML-escaped), twice
//   __MODEL_BASE64__  gzipped .glb as base64, inside <script id="model-glb">
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(process.argv[2] ??
  path.join(here, '..', 'src', 'RevitThreeExport', 'Resources', 'viewer.html'));

const template = fs.readFileSync(path.join(here, 'src', 'template.html'), 'utf8');
const r = await esbuild.build({
  entryPoints: [path.join(here, 'src', 'viewer.js')], bundle: true, minify: true,
  target: 'es2020', write: false, legalComments: 'eof', logLevel: 'warning', format: 'iife',
});
// an inlined script must not contain "</script"
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const modelTag = '<script id="model-glb" type="application/octet-stream" data-encoding="gzip-base64">' +
  '__MODEL_BASE64__</script>';
const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' +
  template.replace('__MODEL_TAG__', () => modelTag).replace('__APP_TAGS__', () => `<script>${js}</script>`) +
  '\n</body>\n</html>\n';

const count = (s) => html.split(s).length - 1;
if (count('__TITLE__') !== 2) throw new Error(`expected 2 __TITLE__ placeholders, found ${count('__TITLE__')}`);
if (count('__MODEL_BASE64__') !== 1) throw new Error('expected 1 __MODEL_BASE64__ placeholder');
if (!/three\.js authors/i.test(js) && !/@license/.test(js)) throw new Error('three.js licence comment missing');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
const three = JSON.parse(fs.readFileSync(path.join(here, 'node_modules', 'three', 'package.json'), 'utf8')).version;
console.log(`${path.relative(process.cwd(), outFile)}: ${(html.length / 1024).toFixed(0)} KB, three ${three}`);
