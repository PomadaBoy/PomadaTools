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
| Click / tap | inspect an element: parameters, materials, **Copy** ID, **Zoom to**. On phones the details come up from the bottom: close them with ×, a swipe down on their top edge, or the phone's Back button |
| ⌄ next to the title | folds the model information away (folded at first on phones) |
| Drag / right-drag / scroll | orbit / pan / zoom; double-click or **Fit model** fits the view |
| <kbd>F</kbd> / <kbd>Esc</kbd> | fit the selection / clear it |
| **Hide / Isolate** | the bar at the clicked element (in the inspect sheet on phones). ▼ offers this element, same type, family, category or level. **Undo** and **Show all** appear under the tools |
| <kbd>H</kbd><kbd>H</kbd> <kbd>H</kbd><kbd>I</kbd> <kbd>H</kbd><kbd>C</kbd> <kbd>I</kbd><kbd>C</kbd> <kbd>H</kbd><kbd>R</kbd> | Revit's keys: hide / isolate the element, hide / isolate its category, show all. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes |
| **Cut** (same bar) | **Add cut**: a section plane on the clicked face, keeping what is behind it. **Box cut**: a section box around the element. Drag the orange arrows to move a plane or resize the box; the **Cuts** card under the tools has a slider, **Flip**, **Zoom to** and **Remove** |
| **Measure** | **Point to point** (corners within 12 px snap; shows the distance and ΔX ΔY ΔZ), **3-axis laser** (click a surface: its **length** and **width** on a floor, deck or footing, along the nearest edge of the clicked face and square to it, so skewed elements are measured along their own sides; **length** and **height** on a wall; its **thickness** through the element; the **clear** distance straight out to the next surface), **Position** (survey coordinates East, North and elevation, or Revit's internal ones when the model has no shared coordinates). <kbd>Esc</kbd> drops a first point, then stops measuring |
| Property row (hover, or tap on phones) | **Copy** the value, **Colour by** this parameter, **Filter on value** |
| **Explode** | From centre, Vertical or By category, 0–100 %, **Reset** |
| **Filter** | search, Category/Family/Type/Level/Material checkboxes, rules (equals, contains, >, ≥, has value …, combined with all/any), **Isolate / Ghost / Hide matching**, a list of the matching elements |
| **Colour** | colour by any parameter, with a legend: each value, or a number range. Untick a legend row to hide those elements |
| **Quantities** | a take-off table along the bottom: elements grouped by any parameters (Category and Type to start), a **Count** and the totals of any parameters (**Sum**, Average, Min or Max), **+ Formula** columns such as `[Volume] * 2400`, **Every element** for one row per element. Counts the elements **Shown** (filter, hide and isolate apply) or **All**. Click a header to sort, a row to highlight and zoom to its elements, the row's buttons to isolate or hide them. **Excel** (.xlsx) and **CSV** download the table. Drag the top edge to resize |
| **Copy filtered IDs** | comma-separated IDs for Revit's *Select by ID* (elements of linked models are left out) |
| **Download .glb** | the 3D model as glTF binary, for Blender and other tools |

Numeric rules read the number at the start of a value, so `Volume > 8` matches
"8.53 m³", and `Faktor ≤ 1,5` works with decimal commas.

**Filter on value** adds the rule *parameter equals value*; a second value of the same
parameter replaces the first instead of matching nothing. Hide and isolate work on top of
the filter: an element shows when the filter shows it and it is not hidden by hand.

**Quantities** add up the exact values the exporter writes next to Revit's text (the text is
rounded: Area "86 m²" may be 86.37), so totals match Revit's schedules; files exported before
this change add up the text. A column of numbers shows the unit and the decimals of the
text, and at least two decimals when the text is rounded to whole numbers; values with
different units in one column are not added up. Text columns show the value when a group
has one, else *varies*. Formula columns use `[Parameter]` names (any case), numbers,
`+ - * /` and brackets; an element without one of the values is left out of that total.
The Excel file has the model, view, date and which elements were counted above the table,
and keeps numbers as numbers; the CSV uses `;` and decimal commas where the computer's
region writes decimals with a comma, so Excel opens it in columns. The columns and grouping
are remembered for each model in that browser.

### Speed

The viewer draws a frame only when something changes, so a model that is not moving costs
nothing. While the view moves on a slow computer it draws at a lower resolution, and parts
smaller than a pixel or two (bolts of a steel model seen whole) are left out until it stops.
All elements are drawn in a few batched draw calls (a 28,000-element steel hall: 2 instead of
28,000). Heavy meshes (rebar, swept railings, imported DWG) get lighter versions for drawing
far away (also parts repeated thousands of times): at most 5 mm, 5 cm or 50 cm from the real surface, used only where that is under a
pixel on screen. Clicking, snapping and measuring always use the full geometry, so measured
values never change. A spatial index makes clicks take a few milliseconds on any model.

On the test bridge in software rendering (like a slow PC), orbiting went from 199 to 25 ms
a frame, with rebar from 579 to 43 ms.

`viewer/bench.mjs <file.html>` measures a file; `viewer/repack.mjs <old.html> <new.html>`
puts the model of an older export into the current viewer.

Measurements are in metres, between the points as built: measuring an exploded model gives
the same numbers as before exploding. Positions use the project's shared (survey) coordinates when it has
them, as in Revit's survey point; ΔX ΔY ΔZ of a distance are along the project axes. Picking and measuring skip hidden,
ghosted and cut-away parts.

**Colour** gives the 8 most common values their own colours and the rest grey ("Other"),
because more colours can't be told apart. Elements with no value are light grey. Material
colours each part of an element by its own material. A number range has up to 4 steps
with about as many elements in each, light for small numbers and dark for large, so one
very large element doesn't put everything else in the first step. Codes such as BOQ
positions "5.1.3" count as text. The colours are checked for colour-blind readers, and
follow the light or dark theme.

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
  gzip + base64 round trip, HTML streaming, shared vertices of flat facets, element origins
  and turned elements, shared meshes, and a box 20 km out that keeps its 1234.5 × 16 mm to
  the micrometre. Writes `tests/out/` (cube, synthetic model, a 28,000-element steel hall
  `stress.html`, `far.html`).
- `viewer/test/glb.test.mjs`: the Khronos glTF validator and three's GLTFLoader on those files.
- `viewer/test/logic.test.mjs`: filter operators, number parsing, explode offsets, colour
  schemes (values, Other, ranges, codes), cut and measure geometry (handle drag, clipping
  side, Revit axes).
- `viewer/test/qto.test.mjs`: quantity take-off (exact values before rounded text, units and
  decimals, grouping, subtotals, Sum/Average/Min/Max, sorting, one row per element, formulas
  and their errors), CSV for comma and point regions, and the .xlsx zip (CRCs, parts, cells).
- `viewer/test/viewer.test.mjs` (Playwright, headless Chromium, `file://`): loading, picking,
  explode and exact Reset, every operator, Isolate/Ghost/Hide, search, facets, the list,
  Copy IDs, Download .glb, hide/isolate from the bar and the keys, property row actions,
  colour by (theme change included), cuts (picking through them, dragging the arrows),
  measuring (corner snapping, exploded model, laser hits on element faces), quantities (exact
  totals, the filter, columns, grouping, sorting, rows that isolate or hide, formulas, the
  Excel and CSV downloads, remembered setup, resizing), the layout on desktop and phone (icons,
  folding model information, closing the details sheet with ×, a swipe and Back), drawing only
  on changes, the batches following selection / hide / ghost, the same hits with and without
  the spatial index and the lighter versions, and measuring 1234.5 mm and 16 mm 20 km out.

## File format

The .glb inside the page (gzip + base64 in `<script id="model-glb" data-encoding="gzip-base64">`)
uses the prototype's layout: a root node with the export info in `extras`, one node per category,
and one node per element. Each element has its metadata in `extras` (`id, uniqueId, category,
family, type, level, mark, comments, volume_m3, materials, params, paramNumbers, typeRef`, plus
`link` and `linkInstanceId` for linked elements). `params` hold Revit's display text;
`paramNumbers` the exact value of each number parameter, in the unit of its text
(`"Area": "86 m²"` next to `"Area": 86.3712`), rounded to 10 significant digits. Type
parameters are stored once per type, in the root's `extras.types`:
`types[typeRef] = { params, numbers }` (files exported before this have `typeParams` and
`typeParamNumbers` on every element; the viewer reads both).

Each element node has its own origin: its `translation` (or `matrix` for a turned family
instance), and positions relative to it, so float32 positions keep sub-micrometre precision
however far an element is from the model's centre. A family instance's positions are its
family's own geometry, the same numbers for every instance of the type, and elements with
identical geometry share one glTF mesh (a steel hall with 27,000 bolts, nuts and plates: 9
meshes; its file went from 16 MB to 2 MB). Mirrored and scaled instances are stored as they
stand. Coordinates are metres, Y up, recentred:
`revit_m = (x + o.x, −z + o.y, y + o.z)` for a point `(x, y, z)` after its node's transform,
with `o = revitOffsetMetres` (not rounded). When the project has
shared coordinates, the root `extras` also hold `sharedCoordinates` (`location`, `origin`,
`basisX`, `basisY`, `basisZ`): `shared = origin + revit_m.x·basisX + revit_m.y·basisY + revit_m.z·basisZ`.

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
  **Colour** in the browser can colour by any parameter instead.
- Element IDs of linked models belong to the link document, so they are left out of
  Copy filtered IDs.
- Very large models (several million triangles) make big files. Leave out rebar, or export
  a view with a section box. After an export the button lists the ten elements with the most
  triangles, with a link that selects each in Revit.
- The volume comes from the element's solids, or else the Revit volume parameter.
- Cut faces are open, not filled: you look into the cut elements.
- No 2D section drawing (Dalux's "2D cut").
- The spatial index and the lighter versions are made in the first seconds after the model
  shows; until then clicks on very heavy models are slower and the full geometry is drawn.
- Thin parts far away (rebar seen from across a bridge) are drawn with their lighter versions
  and may look a little thinner than at full detail.
