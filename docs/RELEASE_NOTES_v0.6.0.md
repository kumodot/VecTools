# VecTools v0.6.0

- **Width → thickness** (thickness by coverage): the 2D local stroke-width map now scales the base slab thickness, so thin strokes get a thinner, rounder body while wide shapes keep full thickness, like ink would. Works in every profile, preview and bake. *Width ref* (0 = auto), *Width floor* (hairlines never vanish), *Width curve*.
- **Capture by pixel size**: *Longest side* in px replaces the viewport multiplier, with a live line showing the exact output size and the supersampled render size.

Run: `RUN_VecTools_v0.6.0.bat`, or online at https://kumodot.github.io/VecTools/
