#!/usr/bin/env bash
# Generate iOS + Android app icons from the Deepmarks pennant SVG.
#
# Why this script: Apple and Google each want a fixed grid of PNG sizes
# at specific paths inside the native projects. Easier to derive them
# all from one source than hand-maintain 18 PNGs.
#
# Source:  browser-extension/public/pennant.svg (the brand pennant)
# Output:
#   frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
#   frontend/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
#   …and the round + foreground variants Android also wants
#
# We render the pennant at 60% scale on a cream background (matching
# the popup) so the icon looks like a real app rather than a logo
# pasted on transparent. Apple disallows transparency on iOS icons,
# Google merely renders weirdly with it.
#
# Requires: ImageMagick (brew install imagemagick).

set -euo pipefail

cd "$(dirname "$0")/.."   # → frontend/

SVG="../browser-extension/public/pennant.svg"
if [ ! -f "$SVG" ]; then
  echo "✗ source SVG missing: $SVG" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "magick not found — run: brew install imagemagick" >&2
  exit 1
fi

# Brand cream background. Matches the popup's --paper variable.
BG='#F5EDE0'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Render the SVG once at 1024 with a cream background, pennant scaled
# to 60% so it has breathing room inside the rounded-square mask iOS
# applies. -resize 60% on a transparent canvas, then composite
# centered onto a cream square.
echo "→ render base 1024×1024 master"
magick -background none -density 600 "$SVG" -resize 614x614 "$TMP/penn.png"
magick -size 1024x1024 "xc:$BG" "$TMP/penn.png" -gravity center -composite "$TMP/master.png"

# ── iOS ──────────────────────────────────────────────────────────────
# iOS Asset Catalogs accept a single 1024×1024 master since Xcode 14;
# Xcode generates the device-specific variants at build time.
IOS_ICON="ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
echo "→ ios → $IOS_ICON"
magick "$TMP/master.png" -resize 1024x1024 "$IOS_ICON"

# Update the iOS Contents.json so Xcode picks up the single-image
# layout (the default layout assumes a 512×2 file we'd otherwise
# also need to ship).
cat > ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json <<JSON
{
  "images" : [
    {
      "filename" : "AppIcon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
JSON

# Drop the original 512@2x file shipped by Capacitor — replaced by
# our 1024 master.
rm -f ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png

# ── Android ──────────────────────────────────────────────────────────
# Square launcher icons: 5 dpi buckets, each at a fixed pixel size.
# Round launchers use the same source (Android masks them at render).
# macOS ships bash 3.2, which doesn't support associative arrays
# under `set -u`. Use parallel arrays — order matters, both arrays
# must stay aligned.
ANDROID_DPIS=(mdpi hdpi xhdpi xxhdpi xxxhdpi)
ANDROID_SIZES=(48   72   96    144    192)

for i in "${!ANDROID_DPIS[@]}"; do
  dpi="${ANDROID_DPIS[$i]}"
  size="${ANDROID_SIZES[$i]}"
  out_dir="android/app/src/main/res/mipmap-$dpi"
  echo "→ android $dpi (${size}px) → $out_dir/ic_launcher.png"
  magick "$TMP/master.png" -resize "${size}x${size}" "$out_dir/ic_launcher.png"
  magick "$TMP/master.png" -resize "${size}x${size}" "$out_dir/ic_launcher_round.png"
done

# Adaptive-icon foreground (Android 8+). Same image, no background —
# the system renders the cream background separately via
# ic_launcher_background.xml, and apps that use adaptive icons
# composite the two with various masks (circle, squircle, etc).
# Render at 432×432 — Android's recommended foreground size for
# adaptive icons (108dp × 4 for xxxhdpi).
echo "→ android adaptive foreground"
magick -background none -density 600 "$SVG" -resize 432x432 "$TMP/foreground.png"
for i in "${!ANDROID_DPIS[@]}"; do
  dpi="${ANDROID_DPIS[$i]}"
  size="${ANDROID_SIZES[$i]}"
  fg_size=$((size * 9 / 4))  # 108dp at this dpi
  out="android/app/src/main/res/mipmap-$dpi/ic_launcher_foreground.png"
  magick "$TMP/foreground.png" -resize "${fg_size}x${fg_size}" "$out"
done

# Update the adaptive-icon background color resource so the
# foreground composites onto our brand cream instead of Capacitor's
# default white-ish placeholder.
cat > android/app/src/main/res/values/ic_launcher_background.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$BG</color>
</resources>
XML

# ── Splash / launch screens ─────────────────────────────────────────
# Render a smaller pennant (≈18% of canvas) centered on cream so the
# app boots into a branded screen instead of Capacitor's "C" logo.
#
# iOS: a single 2732×2732 splash that the LaunchScreen.storyboard
# centers and aspect-fills — covers every iPhone + iPad in portrait
# and landscape. Three identical files because Apple's asset catalog
# wants 1x/2x/3x slots.
#
# Android: per-orientation, per-dpi splashes referenced by
# @drawable/splash in styles.xml's SplashScreen theme.

echo "→ render splash master 2732×2732 (pennant ≈18% of canvas)"
SPLASH_PENNANT_PX=492   # 18% of 2732, integer
magick -background none -density 600 "$SVG" \
  -resize "${SPLASH_PENNANT_PX}x${SPLASH_PENNANT_PX}" "$TMP/splash-penn.png"
magick -size 2732x2732 "xc:$BG" "$TMP/splash-penn.png" \
  -gravity center -composite "$TMP/splash-master.png"

# iOS — three copies for the @1x/@2x/@3x slots.
for variant in "" "-1" "-2"; do
  out="ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${variant}.png"
  echo "→ ios → $out"
  magick "$TMP/splash-master.png" -resize 2732x2732 "$out"
done

# Android — per-orientation, per-dpi sizes. Numbers mirror what
# Capacitor's default splash assets ship at; we just replace the
# pixels.
ANDROID_SPLASH_DPIS=(mdpi   hdpi   xhdpi  xxhdpi xxxhdpi)
ANDROID_SPLASH_PORT=(320x480 480x800 720x1280 960x1600 1280x1920)
ANDROID_SPLASH_LAND=(480x320 800x480 1280x720 1600x960 1920x1280)

for i in "${!ANDROID_SPLASH_DPIS[@]}"; do
  dpi="${ANDROID_SPLASH_DPIS[$i]}"
  port="${ANDROID_SPLASH_PORT[$i]}"
  land="${ANDROID_SPLASH_LAND[$i]}"
  port_out="android/app/src/main/res/drawable-port-$dpi/splash.png"
  land_out="android/app/src/main/res/drawable-land-$dpi/splash.png"
  echo "→ android $dpi splash (port $port, land $land)"
  magick "$TMP/splash-master.png" \
    -resize "${port}^" -gravity center -extent "$port" "$port_out"
  magick "$TMP/splash-master.png" \
    -resize "${land}^" -gravity center -extent "$land" "$land_out"
done

# Default drawable/splash.png (used when no orientation-specific match
# wins). 1080×1920 is a safe portrait default for newer devices.
echo "→ android default drawable/splash.png"
magick "$TMP/splash-master.png" \
  -resize "1080x1920^" -gravity center -extent 1080x1920 \
  "android/app/src/main/res/drawable/splash.png"

echo
echo "✓ icons + splash screens regenerated. Run:"
echo "    npm run ios:sync && npm run android:sync"
echo "  to copy them into the running native projects."
