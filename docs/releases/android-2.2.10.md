# Deepmarks Android 2.2.10

Launcher icon fix (for real this time).

- **Home-screen icon is now centered.** 2.2.9 centered the *adaptive*
  icon, but many launchers draw the older pre-rendered `ic_launcher` /
  `ic_launcher_round` PNGs, which still had the pennant baked in
  off-center (upper-left). Those legacy icons are now regenerated from
  the canonical app icon so the pennant is centered in the circle on
  every launcher.
