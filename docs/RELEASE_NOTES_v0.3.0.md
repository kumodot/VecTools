# VecTools v0.3.0

First public release. Image → clean vector → rounded 3D mesh, entirely in your browser. Nothing is uploaded anywhere.

**Run:** download the zip, unzip, double-click `RUN_VecTools_v0.3.0.bat` (needs Python 3). Try the images in `Samples/`.

## Highlights
- **Vectorize**: Otsu / manual threshold, island removal, hole filling, morphology, corner-aware smoothing, cubic Bézier fit, relative-area island filter, paint touch-up (pen / eraser with Photoshop-style shortcuts), SVG and DXF export.
- **Blob / Inflate**: the vector becomes a signed distance field with a rounded profile. Thin strokes automatically become thinner rounded tubes instead of fins. Realtime GPU preview, then bake with marching cubes, Taubin smoothing and island cleanup.
- **Extrude**: classic extrude with optional inset bevel.
- **Look**: HDR / EXR environments (`hdr/` folder), material presets or custom color / metalness / roughness, bloom glow, supersampled anti-aliasing, transparent PNG capture.
- **Navigation**: orbit or game-style fly (W/A/S/D + mouse look), adjustable camera laziness.
- **Projects**: `.vtools` files store every 2D + 3D setting to reuse on other images.
- **Export**: STL, OBJ, PLY (longest side = 100 units, rescale in Blender / Houdini).

Made by Marcelo Souza / Kumodot.art // @Msouza3d. If it saves you time: https://ko-fi.com/msouza3d
