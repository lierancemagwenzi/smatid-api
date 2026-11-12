/**
 * Reading values off ID cards, for every country: dates, names, and taking the label off a line.
 */

// What OCR mixes up where only a digit can be.
const TO_DIGIT = {O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', '|': '1', T: '1', Z: '2', S: '5', G: '6', B: '8'};

const MONTHS = {JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12};

const digits = (s) => s.split('').map((c) => TO_DIGIT[c] || c).join('');

function iso(day, month, year) {
    const d = Number(day);
    const m = Number(month);
    const y = Number(year);
    if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    // 31/02 rolls over into March: not a real date.
    if (date.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The first date in the text, as YYYY-MM-DD, or null. Day first, as on Zimbabwean cards:
 * 12/03/1990, 12-03-1990, 12.03.1990, 12 MAR 1990, 12MAR1990, and OCR look-alikes in the digits.
 */
function parseDate(text) {
    const t = String(text || '').toUpperCase();
    const numeric = t.match(/([0-9OQDILTZSGB|]{1,2})\s*[/.\-]\s*([0-9OQDILTZSGB|]{1,2})\s*[/.\-]\s*([0-9OQDILTZSGB|]{4})/);
    if (numeric) {
        const out = iso(digits(numeric[1]), digits(numeric[2]), digits(numeric[3]));
        if (out) return out;
    }
    const named = t.match(/([0-9OQDILTZSGB|]{1,2})\s*[/.\- ]?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\s*[/.\- ]?\s*([0-9OQDILTZSGB|]{4})/);
    if (named) return iso(digits(named[1]), MONTHS[named[2]], digits(named[3]));
    return null;
}

/** Whole years between a YYYY-MM-DD date and `now`. */
function age(isoDate, now = new Date()) {
    const [y, m, d] = isoDate.split('-').map(Number);
    let years = now.getUTCFullYear() - y;
    if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) years--;
    return years;
}

/** Letters, spaces, hyphens and apostrophes only, uppercased and squeezed; OCR digit look-alikes become letters. */
function cleanName(text) {
    const t = String(text || '').toUpperCase()
        .replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B')
        .replace(/[^A-Z' -]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-' ]+|[-' ]+$/g, '');
    return t.length >= 2 ? t : null;
}

/** The line's text with a label (a RegExp, matched at the start) taken off, and any ":" after it. */
function stripLabel(text, label) {
    const m = String(text).match(new RegExp(`^\\s*(?:${label.source})\\s*[:.\\-]?\\s*`, 'i'));
    return m ? String(text).slice(m[0].length).trim() : String(text).trim();
}

module.exports = {parseDate, age, cleanName, stripLabel, digits, TO_DIGIT};
