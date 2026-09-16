<h1 align="center">VecTools</h1>

<p align="center">
  <a href="https://github.com/kumodot/VecTools/releases/latest"><img alt="version" src="https://img.shields.io/github/v/release/kumodot/VecTools?label=version&color=2ea44f"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-1f6feb"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Browser%20%7C%20Windows%20%7C%20macOS%20%7C%20Linux-555">
  <img alt="stack" src="https://img.shields.io/badge/stack-vanilla%20JS%20%2B%20three.js%2C%20no%20build-8a63d2">
</p>

<p align="center">
  <a href="https://kumodot.github.io/VecTools/"><img alt="Run online" src="https://img.shields.io/badge/%E2%96%B6%20RUN%20VECTOOLS%20ONLINE-no%20install-2bd4c4?style=for-the-badge&labelColor=1e2024"></a>
  &nbsp;
  <a href="https://github.com/kumodot/VecTools/releases/latest"><img alt="Download" src="https://img.shields.io/badge/%E2%AC%87%20DOWNLOAD%20LATEST%20ZIP-run%20local-ffb347?style=for-the-badge&labelColor=1e2024"></a>
  &nbsp;
  <a href="https://ko-fi.com/msouza3d"><img alt="Ko-fi" src="https://img.shields.io/badge/%E2%98%95%20SUPPORT%20ON%20KO--FI-thanks!-ff5f8a?style=for-the-badge&labelColor=1e2024"></a>
</p>

<p align="center"><img src="screenshots/vectools_banner.png" alt="VecTools" width="100%"></p>

**Image → clean vector → 3D mesh.**
Drop a black & white logo or lettering (or your own SVG), tune the trace, then inflate it into a "chocolate bar / Wonka" style rounded mesh with a realtime preview, and export STL / OBJ / PLY for Blender, Houdini or your slicer.

Single-page web app, no build step, no server side, nothing leaves your machine. Runs online at the link above or fully offline from the zip.

**Marcelo Souza / Kumodot.art - 2026 // @Msouza3d**
If this saves you time: [Support Marcelo Souza on Ko-fi](https://ko-fi.com/msouza3d)

**Try it now:** [kumodot.github.io/VecTools](https://kumodot.github.io/VecTools/)

## Screenshots

| Vectorize | Extrude | Blob / Inflate |
|---|---|---|
| ![Vectorize tab](screenshots/VTools_SVG.jpg) | ![Extrude mode](screenshots/VTools_Extrude.jpg) | ![Blob mode](screenshots/VTools_BULGE.jpg) |

The lettering above is `Samples/VecTools_Sample.jpg` traced and inflated with the *Local-width dome* profile, lit by one of the bundled EXRs.

## Run it

**Local (recommended):** download / clone, double-click `RUN_VecTools_v0.4.1.bat`. It starts `python -m http.server` on port 8765 and opens the app. Python 3 required (ES modules and Web Workers do not load from `file://`). On macOS/Linux: `python3 -m http.server 8765` in the folder, then open `http://localhost:8765/`.

**Hosted:** it is a static site, so any static host works. `index.html` redirects to the current versioned entry file.

Try it with the images in `Samples/`. Already have a vector? Drop an `.svg` on either tab (it is rasterized at high resolution and goes straight to 3D).

## Workflow

### 1 · Vectorize
- Drop, paste or pick an image. White-on-black is detected automatically (*Invert*).
- **Threshold**: pre-blur, Otsu or manual level.
- **Cleanup**: remove islands, fill holes, morphological close / open / grow / shrink.
- **Trace**: corner-aware smoothing (sharp corners stay sharp), simplify, cubic Bézier fit, *Drop islands* by relative area.
- **Paint**: Ink pen / Eraser to touch up the source. `X` swap, `B` pen, `V` pan, `[` `]` brush size, `Ctrl+Z` undo.
- Export **SVG** (even-odd fill) or **DXF**, or *Send to 3D*.

### 2 · 3D
- **Extrude**: classic extrude with optional inset bevel.
- **Blob / Inflate**: the good part. The vector becomes a signed distance field and gets a rounded profile:
  - *Rounded extrude*: flat slab with a filleted edge. Strokes thinner than the fillet automatically turn into thinner rounded tubes, so hairlines never become fins.
  - *Pillow / dome* and *Local-width dome*: puffier profiles.
  - Realtime GPU raymarch preview while you drag sliders, then **Bake mesh** (marching cubes + smoothing + island cleanup). The button lights up when the mesh is out of date.
  - *Cut front* / *Cut back*: flat faces from the mid plane, in the preview and in the bake. Cut back at 0 gives a relief with a flat base for 3D printing.
- **Environment**: drop `.hdr` / `.exr` maps in `hdr/` (or load one), rotation, intensity, exposure, HDR background.
- **Material**: presets or custom color / metalness / roughness.
- **Render**: supersampled anti-aliasing, glow, wireframe, flat shading, floor grid.
- **Navigation**: Orbit or Fly (W/A/S/D + mouse look, pointer lock), *Laziness* eases the camera.
- **Capture PNG** at 1x-4x, optionally transparent.
- Export **STL**, **OBJ**, **PLY**. Units: longest side = 100, or set *Export size (mm)* to get the longest side in millimetres directly.

### Projects
*Save project* writes a `.vtools` JSON with every 2D + 3D setting. *Load project* (or drop the file on the app) re-applies them to whatever image is loaded.

## Tech notes
- Trace: marching squares with hole nesting, Chaikin with corner threshold, closed-loop RDP, Schneider Bézier fitting. All in a Web Worker.
- 3D: exact Euclidean distance transform → 3D SDF (rounded box in the distance/height plane) → GLSL raymarch preview → marching cubes bake → Taubin smoothing. Three.js for display, PMREM environments, bloom.
- Self-tests: `node docs/trace-selftest.mjs`, `node docs/mesh-selftest.mjs`.

## Layout
```
index.html               static-host entry (reads version.json, redirects to the versioned app)
version.json             current version + entry file (edit on every bump)
VecTools_vX.Y.Z.html     the app (version in the file name and header)
RUN_VecTools_vX.Y.Z.bat  local launcher
js/                      app code (trace/ = vectorize pipeline, three/ = 3D pipeline)
vendor/                  three.js + addons (vendored, no build step)
hdr/                     environment maps + index.json
Samples/                 test images
screenshots/             README images + share banner
docs/                    self-tests, release notes
```

## License
MIT. Bundles three.js (MIT). See `LICENSE`.
