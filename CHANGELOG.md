# VecTools changelog

## 0.8.2 (2026-09-26)
- **Export > Print (.3mf, 2 parts)**: a single 3MF object made of two components (body + plate) with their relative placement baked in and the plate bottom on z = 0. Bambu Studio / OrcaSlicer / PrusaSlicer open it as one object with two parts, no alignment step, one filament per part. The STL zip stays as an alternative (import both files at once, otherwise the slicer re-centres each one).

## 0.8.1 (2026-09-26)
- Cache-proof loading: every internal module import and worker URL carries `?v=<version>`, and the `.bat` launcher now runs `serve.py` (Cache-Control: no-store). Fixes an update running with a stale module from the browser cache (symptom: Plate on but no plate, brush controls greyed out).
- Print plate UI tolerant to a stale `ui.js`.

## 0.8.0 (2026-09-26)
- **Strut brush** (Print plate > *Draw struts*): draw directly on the plate plane in the 3D viewport. Left button adds a strut, right button cuts the plate, *Brush width* sets the size. Undo (button or Ctrl+Z), Clear, Esc leaves the mode; orbit is paused while drawing. Strokes are stored in world units, saved in the `.vtools`, applied after the automatic struts (so both modes combine) and can run beyond the artwork.

## 0.7.4 (2026-09-26)
- Plate struts: *Extra links* default raised to 14 (was 6) and the slider goes to 60, so the text block gets tied to the frame all around out of the box. Raise it further / lower *Link spacing* for a denser web.

## 0.7.3 (2026-09-26)
- Print plate struts: **Extra links** (every gap between neighbouring pieces up to this length gets a strut, on top of the minimum tree; 0 = minimum only) and **Link spacing** (minimum distance between struts along one shared edge). Long shared edges now get a row of contact points instead of a single weak bar.

## 0.7.2 (2026-09-26)
- Print plate: **One piece** (on by default, Contour shape) with *Strut width*. When the plate comes out in several pieces, every isolated piece is joined to its nearest neighbour by a capsule strut, following a minimum spanning tree of the pieces, so a stray ornament gets a short bar to the closest piece instead of printing loose. Stats show the strut count.

## 0.7.1 (2026-09-26)
- **Project name** field in the top bar (next to Save project). It fills in with the loaded image's name and can be edited any time; once you type a name it sticks across new images (clear it to go back to auto). Used for the `.vtools` file, SVG/DXF, STL/OBJ/PLY, PNG and print zip names, saved in the project and shown in the window title.

## 0.7.0 (2026-09-26)
- **Print plate** (3D tab, Blob mode): backing plate behind the body as a separate part for two-colour printing. Shapes: *Contour* (silhouette + margin; *Bridge gaps* closes gaps narrower than 2x the value so letters share one plate while big empty areas stay open), *Convex hull*, *Box* (corner radius). *Fill holes* / *Min hole*, *Thickness*, *Embed* (overlap into the body), *Edge round*, *Color*. Stats: pieces, holes, triangles, area and volume (with Export size).
- **Export > Print (body + plate .zip)**: `<name>_body.stl` + `<name>_plate.stl` with shared coordinates and a README, ready for "load as a single object with multiple parts" in Bambu Studio / OrcaSlicer. Export size (mm) applies to the whole assembly.
- Turning the plate on enables *Cut back*, so the body sits flat on the plate top.
- Preview, bake and plate now share one pixel-to-world frame: the baked mesh is no longer re-centred on its own bounding box, so it lands exactly where the preview shows it.
- Fix: bake cut depths (*Front height* / *Back depth*) were applied in pixel units instead of world units, so the baked cuts were much shallower than the preview.

## 0.6.1 (2026-09-26)
- Bake workflow: changing any shape setting (Blob, cuts, raster) while *Baked mesh* is on screen now switches the view back to the live *Preview*, so the change is visible immediately. The previous bake stays in memory as *Baked mesh (old)* (still viewable and exportable) until you Bake again. Bake-only settings (Voxel res, Smooth, Drop islands) keep the current view and just light up the button.

## 0.6.0 (2026-09-26)
- *Width → thickness* (Blob group): thickness by coverage. The 2D local stroke-width map (the same field behind *Local-width dome*) now scales the base half thickness, so thin strokes get a thinner, rounder slab like ink would, in every profile. *Width ref* (0 = auto, widest part), *Width floor* (hairlines never vanish) and *Width curve* control it. Preview and bake.
- Capture: *Longest side* in pixels replaces the viewport multiplier; the group shows the exact output size (and the supersampled render size) for the current viewport.

## 0.5.0 (2026-09-26)
- PNG capture: new *Supersample* (1x-4x). The image is rendered at N times the output size in tiles (`camera.setViewOffset`, tiles overlap when glow is on) and box-filtered down by successive 2x halvings, so 4x = 16 samples per pixel. Progress shown in the status bar. Large outputs no longer depend on GPU canvas limits.
- Environment: *Orbit environment* checkbox + *Orbit speed* (°/s, negative reverses) keep the HDR turning so reflections move across the surface. The Rotation slider follows, so projects save the current angle. Paused during capture.

## 0.4.1 (2026-09-16)
- *Export size (mm)* in the Export group: 0 keeps the internal units (longest side = 100), otherwise the exported STL/OBJ/PLY is scaled so its longest side is that many mm. File name gets a `_<mm>mm` suffix.
- `index.html` now reads `version.json` (no-store) before redirecting, so a cached index on GitHub Pages can no longer point at a removed build.

## 0.4.0 (2026-09-16)
- SVG input: drop or load an `.svg` in the Vectorize tab, in the 3D tab (*Load SVG…* or drop on the viewport), or via the file picker. The browser rasterizes it (*SVG raster* slider, default 2048 px, coverage-based so fill colour does not matter) and it runs through the normal pipeline, landing in the 3D tab directly. The vector stays editable in the Vectorize tab.
- Cut front / Cut back: two independent flat cuts from the mid plane, applied to the raymarch preview AND the baked mesh (closed flat faces). Cut back at 0 = relief with a flat base for 3D printing.
- Bake button lights up (pulsing orange, "Bake mesh (changed)") whenever the baked mesh is out of date: voxel res, smooth, drop islands, or any blob/cut change after a bake.

## 0.3.0 (2026-09-16)
- First public release on GitHub.
- `index.html` redirect for static hosting; `hdr/index.json` merged with the folder scan.
- Paint shortcuts: `X` swaps pen/eraser, `B` pen, `V` pan, `[` `]` brush size (Photoshop style), Ctrl+Z undo.
- Navigation group in the 3D tab: Orbit / Fly. *Laziness* slider eases both orbit damping and fly inertia.
- Fly mode: W/A/S/D along the view direction, Q/E (C/Space) down/up, Shift = 3x, drag or pointer-locked mouse to look. Switching back to Orbit keeps the current view (target placed in front of the camera).
- *Hide pointer*: pointer lock in Fly (click to lock, Esc releases), cursor hidden while dragging in Orbit.
- `window.vectools` exposes the two tab controllers for console debugging.

## 0.2.0 (2026-09-15)
- HDR / EXR environment maps: drop files in `hdr/`, pick them in the 3D tab, or load a file directly. Used by the baked mesh (PMREM) and by the raymarch preview (equirect lookup blurred by roughness).
- Material controls: presets + color, metalness, roughness. Environment rotation, intensity, exposure, optional HDR background with blur.
- Render: supersampled anti-aliasing (1x-3x), bloom glow (strength / radius / threshold).
- Capture PNG at 1x-4x viewport resolution, optionally transparent (grid hidden, glow keeps alpha).
- `.vtools` project files: save/load all 2D + 3D settings, drag a project onto the app to load it.
- Paint touch-up in the Vectorize tab: Ink pen / Eraser with brush size, undo (Ctrl+Z) and clear. Strokes are semantic (ink/erase) so they survive an Invert flip; right-drag pans while painting.
- "Drop islands" relative-area filters: 2D drops shapes below X% of the largest shape's area (after all other cleanup); 3D drops disconnected mesh pieces below X% of the largest piece's surface area (after bake).
- `hdr/_sample_studio.hdr`: small synthetic sample so the environment list is never empty.
- Default bake smoothing 3, SDF field smoothing 0.5 px, shader normals with a wider baseline (kills EDT staircase bands).

## 0.1.0 (2026-09-15)
- First build.
- Vectorize tab: pre-blur, Otsu/manual threshold, invert (auto-detected from the border), island removal,
  hole filling, morphological open/close/grow/shrink, marching-squares trace with hole nesting,
  corner-aware Chaikin smoothing, closed-loop RDP simplification, Schneider cubic Bézier fitting,
  live overlay preview, SVG (even-odd) and DXF export.
- 3D tab: bevel extrude (Three.js ExtrudeGeometry) and SDF blob mode with three profiles
  (rounded extrude, pillow dome, local-width dome), realtime GPU raymarch preview with cutaway,
  marching-cubes bake with Taubin smoothing, STL / OBJ / PLY export, material presets.
