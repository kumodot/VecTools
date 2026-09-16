# VecTools v0.4.0

- **SVG input**: already have a vector? Drop an `.svg` on either tab or use *Load SVG…* in the 3D tab. The browser rasterizes it (*SVG raster* slider, 2048 px default; coverage-based, so fill colour does not matter) and it goes through the normal pipeline straight into 3D. Still editable in the Vectorize tab.
- **Cut front / Cut back**: two independent flat cuts from the mid plane, in the raymarch preview and in the baked mesh. *Cut back* at 0 = relief with a flat base, ready to print.
- **Bake out-of-date indicator**: the Bake button pulses orange whenever voxel res, smoothing, island cleanup or any blob/cut setting changed after the last bake.

Run: `RUN_VecTools_v0.4.0.bat`, or online at https://kumodot.github.io/VecTools/
