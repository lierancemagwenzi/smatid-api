# Drawn ID cards (idcard-synth)

Fake Zimbabwean ID cards for training and testing the ZW model before there are real labelled scans.

```bash
npm run idcard:synth -- 300          # draw 300 cards, OCR them, report a dry-run training
npm run idmodel:train -- --country ZW --synthetic storage/synthetic/ZW                        # train + save (inactive)
npm run idmodel:train -- --country ZW --synthetic storage/synthetic/ZW --activate-synthetic   # train + save, and use it
```

1. **`generate.py`** (Python 3, Pillow, numpy) draws the metal and plastic cards with made-up people
   (common Zimbabwean names, valid-format ID numbers, a drawn silhouette for the photo), then "photographs"
   each one: tilted, off-centre, blurred, with glare and JPEG noise.
2. **`ocr.swift`** reads each picture with Apple Vision (built into macOS), giving lines and boxes in the
   same shape the app sends from ML Kit.
3. **`scripts/trainIdModel.js --synthetic <dir>`** trains on them, alone or with real labelled scans.

Output (default `storage/synthetic/ZW/`, not in git): `images/*.jpg`, `labels.jsonl` (what's printed on
each card), `ocr.jsonl` (what was read off its picture).

**Limits.** The layouts are approximations, not copies of the real cards: adjust `TEMPLATES` in
`generate.py` once you have an official specimen. A score on drawn cards flatters the model, so a model
tested only on drawn cards isn't made active unless you pass `--activate-synthetic`. As soon as there are
10+ real labelled scans, only real ones are held back for the test. Drawn cards can't confirm the real
wording on each card or the check-letter rule.
