/**
 * The page's text as rows (pieces on one baseline, left to right), and the amounts and dates in it.
 */

const MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12};

/**
 * An amount as printed: "1,250.40", "-63.00", "(63.00)", "$ 1 250,40" are all read. Null if the text isn't
 * just an amount (optionally with a currency and CR/DR).
 */
function parseAmount(s) {
    let t = String(s || '').trim().toUpperCase();
    if (!t || t.length > 24) return null;
    let sign = 1;
    t = t.replace(/^(USD|ZWG|ZWL|ZAR|US\$|R|\$|£|€)\s*/, '').replace(/\s*(USD|ZWG|ZWL)$/, '');
    if (/\s*(DR|-)$/.test(t)) {
        sign = -1;
        t = t.replace(/\s*(DR|-)$/, '');
    }
    t = t.replace(/\s*CR$/, '');
    if (/^\(.*\)$/.test(t)) {
        sign = -sign;
        t = t.slice(1, -1);
    }
    if (t.startsWith('-')) {
        sign = -sign;
        t = t.slice(1);
    }
    t = t.replace(/^(USD|ZWG|ZWL|\$)\s*/, '');
    // Thousands with commas or spaces, decimals with a point: 1,250.40 / 1 250.40 / 1250.40
    let m = t.match(/^(\d{1,3}(?:[, ]\d{3})+|\d+)\.(\d{2})$/);
    if (m) return {value: sign * Number(`${m[1].replace(/[, ]/g, '')}.${m[2]}`), decimals: 2, style: m[1].includes(',') ? 'comma' : m[1].includes(' ') ? 'space' : 'plain'};
    // Decimals with a comma: 1.250,40 / 1 250,40
    m = t.match(/^(\d{1,3}(?:[. ]\d{3})+|\d+),(\d{2})$/);
    if (m) return {value: sign * Number(`${m[1].replace(/[. ]/g, '')}.${m[2]}`), decimals: 2, style: 'decimal_comma'};
    return null;
}

/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, "12 Sep 2026", "12-Sep-26". {date: 'YYYY-MM-DD'} or {invalid}. */
function parseDate(s) {
    const t = String(s || '').trim();
    let d;
    let mo;
    let y;
    let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
    if (m) [, d, mo, y] = m;
    else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [, y, mo, d] = m;
    else if ((m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]*(\d{4}|\d{2})$/)) && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
        d = m[1];
        mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
        y = m[3];
    } else return null;
    y = Number(y);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    mo = Number(mo);
    d = Number(d);
    const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (!ok) return {invalid: true, text: t};
    return {date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`};
}

/** Every date in a piece of text ("01/09/2026 - 30/09/2026" has two). */
function datesIn(s) {
    const out = [];
    const re = /\b(\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-,]*\d{4})\b/g;
    for (const m of String(s || '').matchAll(re)) {
        const d = parseDate(m[1]);
        if (d) out.push({...d, text: m[1]});
    }
    return out;
}

/**
 * Groups a page's text items into rows: pieces whose baselines are within a fifth of their size of each
 * other. Each row: {y (median baseline), size (median), items (left to right), text}.
 */
function rows(items) {
    const sorted = items.filter((it) => !it.rotated).map((it, i) => ({...it, index: it.index ?? i})).sort((a, b) => b.y - a.y || a.x - b.x);
    const out = [];
    for (const it of sorted) {
        // Tight: separate blocks a couple of points apart (an address beside a phone number) aren't one row.
        const tol = Math.max(1.2, (it.size || 10) * 0.2);
        const row = out.find((r) => Math.abs(r.y - it.y) <= tol);
        if (row) {
            row.items.push(it);
            const ys = row.items.map((i) => i.y).sort((a, b) => a - b);
            row.y = ys[Math.floor(ys.length / 2)];
        } else {
            out.push({y: it.y, items: [it]});
        }
    }
    for (const r of out) {
        r.items.sort((a, b) => a.x - b.x);
        const sizes = r.items.map((i) => i.size).sort((a, b) => a - b);
        r.size = sizes[Math.floor(sizes.length / 2)];
        r.text = r.items.map((i) => i.text.trim()).join(' ');
    }
    return out.sort((a, b) => b.y - a.y);
}

const right = (it) => it.x + it.w;

/** A text item's box as fractions of the page, top-left origin: what the portal draws. */
function boxOf(page, items) {
    const list = Array.isArray(items) ? items : [items];
    const x0 = Math.min(...list.map((i) => i.x));
    const x1 = Math.max(...list.map((i) => i.x + i.w));
    const y0 = Math.min(...list.map((i) => i.y - i.size * 0.22));
    const y1 = Math.max(...list.map((i) => i.y + i.size * 0.9));
    const r = (v) => Math.round(v * 10000) / 10000;
    return [r(x0 / page.width), r(1 - y1 / page.height), r((x1 - x0) / page.width), r((y1 - y0) / page.height)];
}

/** A rectangle in points (x, y bottom-left, w, h) as fractions of the page, top-left origin. */
function rectBox(page, {x, y, w, h}) {
    const r = (v) => Math.round(v * 10000) / 10000;
    return [r(x / page.width), r(1 - (y + h) / page.height), r(w / page.width), r(h / page.height)];
}

const isNumeric = (s) => Boolean(parseAmount(s)) || /^\d[\d\s,./-]{2,}$/.test(String(s).trim());

module.exports = {parseAmount, parseDate, datesIn, rows, right, boxOf, rectBox, isNumeric};
