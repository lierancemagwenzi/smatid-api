/**
 * Drawn ID cards from tools/idcard-synth, as training samples: labels.jsonl (what's printed on each
 * card) joined with ocr.jsonl (what was read off its picture).
 */
const fs = require('fs');
const path = require('path');
const ocrInput = require('./ocrInput');

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** [{lines, label, source: "synthetic", image}] for one country, from a folder made by generate.py and ocr.swift. */
function load(dir, country) {
    const labels = readJsonl(path.join(dir, 'labels.jsonl'));
    const ocr = new Map(readJsonl(path.join(dir, 'ocr.jsonl')).map((r) => [r.image, r.ocr]));
    const samples = [];
    let unread = 0;
    for (const row of labels) {
        if (country && row.country && row.country !== country) continue;
        try {
            samples.push({lines: ocrInput.parse(ocr.get(row.image)), label: row.label, source: 'synthetic', image: row.image});
        } catch {
            // The OCR found no text on the picture (too blurred, all glare): like a scan the app would retake.
            unread++;
        }
    }
    return {samples, unread};
}

module.exports = {load};
