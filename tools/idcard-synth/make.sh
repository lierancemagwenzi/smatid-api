#!/bin/sh
# Draws fake Zimbabwean ID cards, reads them with Apple Vision, and reports how a model trained on them
# would do (nothing is saved). macOS only (the OCR step uses Vision).
#   npm run idcard:synth -- 300            300 cards into storage/synthetic/ZW
#   npm run idcard:synth -- 300 my/dir     somewhere else
set -e
cd "$(dirname "$0")/../.."
COUNT="${1:-300}"
OUT="${2:-storage/synthetic/ZW}"

python3 tools/idcard-synth/generate.py --count "$COUNT" --out "$OUT"
swift tools/idcard-synth/ocr.swift "$OUT"
node scripts/trainIdModel.js --country ZW --synthetic "$OUT" --no-db --dry-run
echo
echo "To train and save:  npm run idmodel:train -- --country ZW --synthetic $OUT [--activate-synthetic]"
