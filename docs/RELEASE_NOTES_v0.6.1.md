# VecTools v0.6.1

- **Bake workflow fix**: changing a shape setting while the baked mesh is on screen used to show nothing (the bake was stale and the preview was hidden). Now the view flips back to the live **Preview** on the first change; the previous bake stays available as **Baked mesh (old)** until you Bake again.
- v0.6.0 features: **Width → thickness** (thin strokes get a thinner, rounder body, like ink) and **capture by pixel size** (*Longest side*, with live output-size info).

Run: `RUN_VecTools_v0.6.1.bat`, or online at https://kumodot.github.io/VecTools/
