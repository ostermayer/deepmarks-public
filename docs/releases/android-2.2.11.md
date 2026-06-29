# Deepmarks Android 2.2.11

Adaptive launcher icon — pennant centered + sized for the masked safe zone.

- **Pixel-style adaptive icon fixed.** 2.2.10 re-centered the legacy
  pre-rendered PNGs, but launchers that use the adaptive
  `ic_launcher_foreground` + `ic_launcher_background` layers (Pixel,
  Android 13+ masked icons, most launchers that draw the round/ squircle
  mask) still showed the pennant oversized and mast-left after
  circle-masking.
- **Foreground regenerated at ~47% of the 108dp canvas.** Regenerated
  `ic_launcher_foreground` (every density) from `pennant.svg`, nudged
  right and down so the optically-centered mast — not the bounding-box
  center — lands at the canvas center. The mast is left-heavy so the
  optical center sits to the right of the geometric center.
- **Legacy PNGs regenerated to match.** `ic_launcher` / `ic_launcher_round`
  at every density (mdpi → xxxhdpi) regenerated from the new foreground
  + gradient background so every launcher style — adaptive mask, legacy
  circle, legacy rounded — shows the same centered pennant.
- **iOS parity:** `2.2.11` / build `40` to match the Android
  `2.2.11` / `versionCode 41` bump.