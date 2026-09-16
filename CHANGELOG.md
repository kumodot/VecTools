# VecTools changelog

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
