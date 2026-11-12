/**
 * Turns an ID card's OCR lines into numbers a model can learn from. Two kinds:
 *
 * - per line, for the field tagger: where the line is, what its text looks like, and which labels are
 *   around it (its own, the one on its left, the one above it);
 * - per card, for the card-type classifier: the lines' averages plus the country's card-type hints.
 *
 * Everything country-specific comes from the country's profile (helpers/idcard/countries/*.js), so the
 * same code serves every country; what differs is the weights each country's model learns.
 * Bump VERSION whenever the features change: a model trained on other features can't be used.
 */
const {parseDate, stripLabel} = require('./common');

const VERSION = 3;

const ratio = (s, re) => (s.length ? (s.match(re) || []).length / s.length : 0);

/** The nearest label line above this one (within three line heights, roughly aligned), or null. */
function labelAbove(line, lines, labelled) {
    const h = line.box[3] || 0.03;
    let best = null;
    let bestD = Infinity;
    for (const l of lines) {
        if (!labelled.has(l.index) || l.index === line.index) continue;
        const dy = line.box[1] - (l.box[1] + l.box[3]);
        if (dy < -h / 2 || dy > h * 3 || Math.abs(l.box[0] - line.box[0]) > 0.2) continue;
        if (dy < bestD) {
            bestD = dy;
            best = labelled.get(l.index);
        }
    }
    return best;
}

/** The nearest label to this line's left on the same row, or null. */
function labelLeft(line, lines, labelled) {
    let best = null;
    let bestX = -Infinity;
    for (const l of lines) {
        if (!labelled.has(l.index) || l.row !== line.row || l.box[0] >= line.box[0]) continue;
        if (l.box[0] > bestX) {
            bestX = l.box[0];
            best = labelled.get(l.index);
        }
    }
    return best;
}

/** One feature vector per line, in the lines' order. */
function lineFeatures(lines, profile) {
    const labelled = new Map();
    for (const l of lines) {
        const f = profile.labelOf(l.text);
        if (f) labelled.set(l.index, f);
    }
    const maxRow = Math.max(1, ...lines.map((l) => l.row));
    const idLine = lines.find((l) => profile.parseIdNumber(l.text));
    const oneHot = (field) => profile.fields.map((f) => (f === field ? 1 : 0));

    return lines.map((line) => {
        const t = line.text.toUpperCase();
        const [x, y, w, h] = line.box;
        const own = labelled.get(line.index) || null;
        const rest = own ? stripLabel(line.text, profile.labels[own]) : line.text;
        return [
            1,
            x, y, w, h, x + w / 2, y + h / 2, x * x, y * y,
            line.row / maxRow,
            Math.min(t.length, 40) / 40,
            ratio(t, /[0-9]/g),
            ratio(t, /[A-Z]/g),
            Math.min((t.match(/\s/g) || []).length, 5) / 5,
            /[/.\-]/.test(t) ? 1 : 0,
            parseDate(t) ? 1 : 0,
            profile.parseIdNumber(t) ? 1 : 0,
            profile.normalise('surname', rest) ? 1 : 0,
            profile.noise.test(t) ? 1 : 0,
            /^(M|F|MALE|FEMALE)$/.test(t.trim()) ? 1 : 0,
            own && rest ? 1 : 0,
            idLine ? (line.index < idLine.index ? -1 : line.index > idLine.index ? 1 : 0) : 0,
            ...oneHot(own),
            ...oneHot(labelLeft(line, lines, labelled)),
            ...oneHot(labelAbove(line, lines, labelled)),
        ];
    });
}

/** One feature vector for the whole card. */
function cardFeatures(lines, profile) {
    const rows = lineFeatures(lines, profile);
    const width = rows[0].length;
    const mean = new Array(width).fill(0);
    for (const r of rows) for (let i = 0; i < width; i++) mean[i] += r[i] / rows.length;
    const all = lines.map((l) => l.text).join(' ').toUpperCase();
    const hints = Object.values(profile.cardTypeHints || {}).map((re) => (re.test(all) ? 1 : 0));
    return [...mean, ...hints, Math.min(lines.length, 40) / 40];
}

module.exports = {VERSION, lineFeatures, cardFeatures};
