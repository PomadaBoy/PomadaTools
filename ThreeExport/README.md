# Export 3D HTML (Revit → three.js)

Exports the elements visible in a Revit 3D view to **one self-contained .html file**.
It opens by double-click in any modern browser, works offline and can be emailed.
In the file you can orbit the model, click elements to see all their parameters,
explode the model and filter it by properties.

- Button: **PBTools → WIP → Export 3D HTML** (pyRevit, IronPython)
- Core: `src/RevitThreeExport` (C#, one DLL for Revit 2021–2024 on .NET 4.8, one for 2025+ on .NET 8)
- Viewer: `viewer/` (three.js 0.187.0, bundled into the DLL)

## Use

1. Open the 3D view to export, or start the button from any view and pick a 3D view.
2. Choose options:
   - **Include linked models**: elements of loaded links shown in the view.
   - **Include type parameters**.
   - **Include rebar**: rebar is often most of the triangles. Leaving it out made the
     test bridge 19 MB instead of 50 MB.
   - **Open the file when done**.
3. Choose where to save. The progress bar has **Cancel**. Nothing in the model changes,
   and no transaction is opened.

What gets exported is what Revit draws in the view: hidden elements and categories,
filter visibility, phase filter, section box, detail level and links are respected.
Colours come from the materials, not from view overrides.

### In the browser

| | |
|---|---|
| Click / tap | inspect an element: parameters, materials, **Copy** ID, **Zoom to** |
| Drag / right-drag / scroll | orbit / pan / zoom; double-click or **Fit model** fits the view |
| <kbd>F</kbd> / <kbd>Esc</kbd> | fit the selection / clear it |
| **Explode** | From centre, Vertical or By category, 0–100 %, **Reset** |
| **Filter** | search, Category/Family/Type/Level/Material checkboxes, rules (equals, contains, >, ≥, has value …, combined with all/any), **Isolate / Ghost / Hide matching**, a list of the matching elements |
| **Copy filtered IDs** | comma-separated IDs for Revit's *Select by ID* (elements of linked models are left out) |
| **Download .glb** | the 3D model as glTF binary, for Blender and other tools |

Numeric rules read the number at the start of a value, so `Volume > 8` matches
"8.53 m³", and `Faktor ≤ 1,5` works with decimal commas.

## Build

Needs Node.js and the .NET SDK (8 or newer). From this folder:

```powershell
.\build.ps1          # viewer template + both DLLs, copied to the button's bin\
.\build.ps1 -Test    # also all tests
```

The button loads the DLL from its bytes (`Assembly.Load(File.ReadAllBytes(...))`), so it
is never locked and can be rebuilt while Revit is open. The next click uses the new DLL.
RevitAPI.dll is never shipped: it comes from the reference-only
`Nice3point.Revit.Api.RevitAPI` packages. The DLL has no third-party runtime dependencies.

### Tests

- `tests/RevitThreeExport.Tests` (xUnit): JSON escaping (Serbian letters, m³, control
  characters, lone surrogates), GLB layout, materials, axes, recentring, index types,
  gzip + base64 round trip, HTML streaming. Writes `tests/out/` (cube, synthetic model).
- `viewer/test/glb.test.mjs`: the Khronos glTF validator and three's GLTFLoader on those files.
- `viewer/test/logic.test.mjs`: filter operators, number parsing, explode offsets.
- `viewer/test/viewer.test.mjs` (Playwright, headless Chromium, `file://`): loading, picking,
  explode and exact Reset, every operator, Isolate/Ghost/Hide, search, facets, the list,
  Copy IDs, Download .glb, and the layout on desktop and phone.

## File format

The .glb inside the page (gzip + base64 in `<script id="model-glb" data-encoding="gzip-base64">`)
uses the prototype's layout: a root node with the export info in `extras`, one node per category,
and one node per element. Each element has its metadata in `extras` (`id, uniqueId, category,
family, type, level, mark, comments, volume_m3, materials, params, typeParams`, plus `link` and
`linkInstanceId` for linked elements). Coordinates are metres, Y up, recentred:
`revit_m = (x + o.x, −z + o.y, y + o.z)` with `o = revitOffsetMetres`.

## Checklist in Revit

- [x] Revit 2025, "Test model 3js", view "Export": 185 elements (Roofs 54, Generic Models 44,
      Structural Rebar 39, Floors 26, Walls 18, Structural Framing 3, one DWG), 23 materials,
      2.45 M triangles, 50 MB, 4 s. The 142 elements it shares with the prototype export match
      it exactly (positions, names, materials, volumes).
- [ ] The original "Most Voisavljevica" model: 178 elements (Floors 26, Generic Models 44,
      Roofs 54, Walls 54), about 22 materials; element 843064 = Walls / "Obloga od Kulira" /
      about 8.53 m³ / level "Nula".
- [ ] Revit 2023 (the .NET 4.8 DLL).
- [ ] Hide a category in the view, export again: those elements are gone.
- [ ] A model with a loaded link: the link's elements are exported with the link name.
- [ ] A large model: the time and size are reported, and Cancel works.
- [ ] Rebuild the DLL while Revit is open, then export again: no locked file.

## Known limits

- View colour overrides and filter colours are not exported; colours come from materials.
- Element IDs of linked models belong to the link document, so they are left out of
  Copy filtered IDs.
- Very large models (several million triangles) make big files. Leave out rebar, or export
  a view with a section box.
- The volume comes from the element's solids, or else the Revit volume parameter.
