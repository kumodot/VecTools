# VecTools v0.7.0

- **Print plate**: a backing plate behind the body, as a **separate part** so it gets its own filament colour. Shapes: *Contour* (follows the art; *Bridge gaps* joins the letters into one plate while large empty areas stay open, a hollow plate that saves filament), *Convex hull*, *Box*. Margin, fill holes / min hole, thickness, embed, edge rounding, colour, plus area / volume stats.
- **Export > Print**: one zip with `_body.stl` + `_plate.stl` in shared coordinates. In Bambu Studio / OrcaSlicer import both and accept "load as a single object with multiple parts", then pick a filament per part.
- Preview, bake and plate share one pixel-to-world frame, so the parts line up exactly.
- Fix: baked *Front height* / *Back depth* cuts were applied in the wrong units (much shallower than the preview).

Run: `RUN_VecTools_v0.7.0.bat`, or online at https://kumodot.github.io/VecTools/
