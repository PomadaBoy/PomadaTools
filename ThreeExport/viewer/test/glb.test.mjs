// Checks the .glb files written by the C# tests (ThreeExport/tests/out) with the
// Khronos glTF validator and with three.js's own GLTFLoader, as the viewer loads them.
//   dotnet test ../tests/RevitThreeExport.Tests   (writes tests/out/*.glb)
//   node --test test/glb.test.mjs
// REFERENCE_GLB=path/to/prototype.glb also checks a prototype export the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'tests', 'out');
const files = ['cube.glb', 'synthetic.glb'].map((f) => path.join(out, f));
if (process.env.REFERENCE_GLB) files.push(path.resolve(process.env.REFERENCE_GLB));

const load = (file) => {
  const buf = fs.readFileSync(file);
  return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
};

for (const file of files) {
  test(`${path.basename(file)} passes the Khronos glTF validator`, async () => {
    assert.ok(fs.existsSync(file), `${file} is missing: run dotnet test first`);
    const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(file)), { maxIssues: 50 });
    const errors = report.issues.messages.filter((m) => m.severity === 0);
    assert.deepEqual(errors, [], JSON.stringify(errors, null, 1));
    // warnings are allowed (none expected), but show them
    const warnings = report.issues.messages.filter((m) => m.severity === 1);
    if (warnings.length) console.log(path.basename(file), 'warnings:', warnings.map((w) => w.code).join(', '));
  });

  test(`${path.basename(file)} loads in three.js GLTFLoader with element userData`, async () => {
    const gltf = await load(file);
    const root = gltf.scene.children[0];
    assert.equal(root.userData.source, 'Revit');
    assert.equal(root.userData.upAxis, 'Y');
    const elements = [];
    gltf.scene.traverse((o) => { if (o.userData?.id && o.userData?.category) elements.push(o); });
    assert.equal(elements.length, root.userData.elementCount);
    for (const cat of root.children) assert.equal(cat.userData.kind, 'category');
    const e = elements.find((o) => o.userData.id === 843064);
    if (e) {
      assert.equal(e.userData.category, 'Walls');
      assert.equal(e.userData.type, 'Obloga od Kulira');
      assert.equal(e.userData.level, 'Nula');
      assert.equal(e.userData.volume_m3, 8.5254);
      assert.equal(e.userData.params.Volume, '8.53 m³');
    }
    // every element mesh has an index and normals, materials carry sRGB swatches
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      assert.ok(o.geometry.index, 'indexed');
      assert.ok(o.geometry.attributes.normal, 'has normals');
      assert.ok(Array.isArray(o.material.userData.rgb), 'material extras.rgb');
    });
  });
}

test('synthetic model counts match what the C# writer reported', async () => {
  const stats = JSON.parse(fs.readFileSync(path.join(out, 'synthetic.stats.json'), 'utf8'));
  const gltf = await load(path.join(out, 'synthetic.glb'));
  const perCat = {};
  let tris = 0;
  gltf.scene.traverse((o) => {
    if (o.userData?.id && o.userData?.category) perCat[o.userData.category] = (perCat[o.userData.category] ?? 0) + 1;
    if (o.isMesh) tris += o.geometry.index.count / 3;
  });
  assert.deepEqual(perCat, stats.perCategory);
  assert.equal(tris, stats.triangles);
  const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  // 4 storeys of 4 m, and the linked foundations from 1.5 m below: Revit Z -> glTF Y
  assert.ok(Math.abs(size.y - 17.5) < 0.01, `height ${size.y}`);
});
