#!/usr/bin/env bash
# Turn a popup/window screenshot into a Chrome Web Store-ready 1280x800 PNG.
#
# The Chrome Web Store caps screenshots at 1280x800 — there is no retina
# upload — so the only lever for "retina quality" is the resampler. We
# use ImageMagick with the Lanczos filter, which preserves text edges
# noticeably better than sips's default bicubic when scaling 2x captures
# down 0.5–0.7x. Output is a 24-bit PNG with no alpha.
#
# Usage:
#   scripts/make-store-screenshot.sh INPUT [OUTPUT] [BG_HEX]
#
# Defaults: OUTPUT = INPUT-1280x800.png next to INPUT.
#           BG_HEX = F5EDE0 (cream — matches the popup background)
#
# Requires:
#   brew install imagemagick

set -euo pipefail

INPUT=${1:?"usage: $0 INPUT [OUTPUT] [BG_HEX]"}
OUTPUT=${2:-"${INPUT%.*}-1280x800.png"}
BG=${3:-F5EDE0}

if ! command -v magick >/dev/null 2>&1; then
  echo "magick not found — run: brew install imagemagick" >&2
  exit 1
fi

# Scale to fit 1280×800 preserving aspect, then pad to the full canvas
# with the brand color. ImageMagick's -resize "1280x800" is fit-within
# (doesn't upscale beyond source dims, doesn't squish aspect). Lanczos
# is the sharpest practical filter for ~0.5-0.7x downscales of text-
# heavy screenshots.
magick "$INPUT" \
  -filter Lanczos \
  -resize 1280x800 \
  -background "#$BG" \
  -gravity center \
  -extent 1280x800 \
  -alpha remove -alpha off \
  -strip \
  PNG24:"$OUTPUT"

OW=$(magick identify -format "%w" "$OUTPUT")
OH=$(magick identify -format "%h" "$OUTPUT")
echo "wrote $OUTPUT  (${OW}x${OH})"
