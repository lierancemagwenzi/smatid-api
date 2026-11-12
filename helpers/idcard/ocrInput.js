/**
 * The text the app read off an ID card: each line, and where it sits on the picture.
 *
 *   {"lines": [{"text": "SURNAME", "box": [0.31, 0.22, 0.18, 0.04]}, …]}
 *
 * `box` is [left, top, width, height] as fractions of the picture (0-1), so it doesn't matter what size
 * the picture was. The lines come back sorted top to bottom, then left to right, with each line's `index`
 * in that order: the model and the rules both rely on that.
 */

const MAX_LINES = 200;
const MAX_TEXT = 200;

class OcrInputError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

// Cyrillic and Greek letters OCR returns for Latin ones that look the same ("Т 48 СIT" is Т and С).
const HOMOGLYPHS = {
    А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's',
    Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
    ο: 'o', ν: 'v', κ: 'k',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');
const latin = (text) => text.replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c]);

const fraction = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -0.05 && v <= 1.05;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Validates and normalises the app's OCR. Throws OcrInputError('ocr_required' | 'invalid_ocr'). */
function parse(value) {
    if (value === undefined || value === null) throw new OcrInputError('ocr_required');
    const raw = Array.isArray(value) ? value : value && Array.isArray(value.lines) ? value.lines : null;
    if (!raw) throw new OcrInputError('invalid_ocr');
    if (raw.length > MAX_LINES) throw new OcrInputError('invalid_ocr');

    const lines = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || typeof item.text !== 'string') throw new OcrInputError('invalid_ocr');
        const text = latin(item.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
        if (!text) continue;
        const box = item.box;
        if (!Array.isArray(box) || box.length !== 4 || !box.every(fraction) || box[2] < 0 || box[3] < 0) throw new OcrInputError('invalid_ocr');
        const [left, top, width, height] = box.map(clamp01);
        lines.push({text, box: [left, top, Math.min(width, 1 - left), Math.min(height, 1 - top)]});
    }
    if (!lines.length) throw new OcrInputError('ocr_required');
    return sortLines(toTextArea(lines));
}

/**
 * Boxes as fractions of the area the text covers, not of the whole picture, so it doesn't matter where
 * the card sat in the photo or how close the phone was: the same field lands in the same place.
 */
function toTextArea(lines) {
    const left = Math.min(...lines.map((l) => l.box[0]));
    const top = Math.min(...lines.map((l) => l.box[1]));
    const width = Math.max(...lines.map((l) => l.box[0] + l.box[2])) - left;
    const height = Math.max(...lines.map((l) => l.box[1] + l.box[3])) - top;
    // One line, or a column of them: nothing to scale against in that direction.
    const sx = width > 0.05 ? 1 / width : 1;
    const sy = height > 0.05 ? 1 / height : 1;
    const ox = width > 0.05 ? left : 0;
    const oy = height > 0.05 ? top : 0;
    const r = (v) => Math.round(v * 10000) / 10000;
    return lines.map((l) => ({...l, box: [r((l.box[0] - ox) * sx), r((l.box[1] - oy) * sy), r(l.box[2] * sx), r(l.box[3] * sy)]}));
}

/**
 * Top to bottom, then left to right. Lines whose middles are within half a line height of each other
 * count as one row, so a label and its value on the same row keep their left-to-right order.
 */
function sortLines(lines) {
    const mid = (l) => l.box[1] + l.box[3] / 2;
    const sorted = [...lines].sort((a, b) => mid(a) - mid(b));
    const rows = [];
    for (const line of sorted) {
        const row = rows[rows.length - 1];
        const tolerance = Math.max(line.box[3], row ? row[0].box[3] : 0) / 2;
        if (row && Math.abs(mid(line) - mid(row[0])) <= tolerance) row.push(line);
        else rows.push([line]);
    }
    let index = 0;
    const out = [];
    rows.forEach((row, r) => {
        row.sort((a, b) => a.box[0] - b.box[0]);
        for (const line of row) out.push({...line, row: r, index: index++});
    });
    return out;
}

module.exports = {parse, sortLines, latin, OcrInputError, MAX_LINES};
