/**
 * Layout. A system lays out every row and column to the same grid, so an edit by hand shows up as text a
 * little off its row, a figure that doesn't line up with its column, text drawn on top of other text, or a
 * white box hiding what was there.
 */
const {rows, right, boxOf, rectBox, parseAmount, isNumeric} = require('./text');
const {median} = require('./fonts');

const light = (c) => c && c[0] >= 235 && c[1] >= 235 && c[2] >= 235;
const inside = (pt, r, pad = 1) => pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const itemRect = (it) => ({x: it.x, y: it.y - it.size * 0.2, w: it.w, h: it.size * 1.0});

function pageFindings(page) {
    const out = [];
    const rs = rows(page.items);

    // Off the row's baseline: a piece sitting a little above or below its neighbours on the row. Judged
    // against the pieces near it (a table row), not text in another block across the page.
    for (const row of rs) {
        if (row.items.length < 3) continue;
        for (const it of row.items) {
            if (it.size < row.size * 0.8) continue; // superscripts and footnote marks
            const mates = row.items.filter((o) => o !== it && Math.abs((o.x + o.w / 2) - (it.x + it.w / 2)) < 250);
            if (!mates.length) continue;
            const ys = mates.map((o) => o.y).sort((a, b) => a - b);
            const off = it.y - ys[Math.floor(ys.length / 2)];
            const tol = Math.max(0.6, row.size * 0.07);
            if (Math.abs(off) > tol && Math.abs(off) < row.size * 0.45) {
                out.push({
                    category: 'layout', code: 'off_baseline', severity: isNumeric(it.text) && Math.abs(off) >= 1 ? 'high' : 'warning',
                    title: `"${it.text.trim()}" sits ${Math.abs(off).toFixed(1)} pt ${off > 0 ? 'above' : 'below'} its row`,
                    detail: 'Everything else on the row shares one baseline. Text added by hand rarely lands exactly on it.',
                    page: page.number, box: boxOf(page, it), evidence: {text: it.text.trim(), offset_pt: Math.round(off * 100) / 100},
                });
            }
        }
    }

    // Right-aligned figure columns: amounts whose right edges agree, bar one that's a little out.
    const amounts = page.items.filter((it) => parseAmount(it.text));
    const columns = [];
    for (const it of amounts) {
        const col = columns.find((c) => Math.abs(c.right - right(it)) <= 6);
        if (col) {
            col.items.push(it);
            col.right = median(col.items.map(right));
        } else columns.push({right: right(it), items: [it]});
    }
    for (const col of columns.filter((c) => c.items.length >= 4)) {
        const exact = col.items.filter((it) => Math.abs(right(it) - col.right) < 0.3).length;
        if (exact < col.items.length * 0.6) continue; // not a right-aligned column
        for (const it of col.items) {
            const off = right(it) - col.right;
            if (Math.abs(off) >= 0.6) {
                out.push({
                    category: 'layout', code: 'column_misaligned', severity: 'warning',
                    title: `"${it.text.trim()}" doesn't line up with its column`,
                    detail: `Its right edge is ${Math.abs(off).toFixed(1)} pt ${off > 0 ? 'right' : 'left'} of the ${col.items.length - 1} other figures in the column.`,
                    page: page.number, box: boxOf(page, it), evidence: {text: it.text.trim(), offset_pt: Math.round(off * 100) / 100},
                });
            }
        }
    }

    // Text drawn on top of other text.
    const items = page.items.filter((it) => !it.rotated);
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const a = itemRect(items[i]);
            const b = itemRect(items[j]);
            const area = overlapArea(a, b);
            if (area > 0.5 * Math.min(a.w * a.h, b.w * b.h) && items[i].text.trim() !== items[j].text.trim()) {
                out.push({
                    category: 'layout', code: 'text_over_text', severity: 'high',
                    title: `"${items[j].text.trim()}" is written over "${items[i].text.trim()}"`,
                    detail: 'Two different pieces of text occupy the same place. The one underneath is usually what was there first.',
                    page: page.number, box: boxOf(page, [items[i], items[j]]), evidence: {under: items[i].text.trim(), over: items[j].text.trim()},
                });
            }
        }
    }

    // A white box drawn over text that was already there.
    for (const fill of page.fills) {
        if (!light(fill.color) || fill.w * fill.h > page.width * page.height * 0.25 || fill.w < 2 || fill.h < 2) continue;
        const hidden = page.texts.filter((t) => t.order < fill.order && inside(t, fill));
        if (!hidden.length) continue;
        const under = page.items.filter((it) => hidden.some((t) => Math.abs(t.x - it.x) < 1 && Math.abs(t.y - it.y) < 1));
        const written = page.texts.filter((t) => t.order > fill.order && inside(t, fill));
        out.push({
            category: 'layout', code: 'text_covered', severity: 'high',
            title: under.length ? `"${under.map((u) => u.text.trim()).join(' ')}" is hidden under a white box` : 'Text is hidden under a white box',
            detail: written.length ? 'A white box was drawn over text, and new text written on top of it: the classic way of changing a figure.'
                : 'A white box was drawn over text after it was written.',
            page: page.number, box: rectBox(page, fill), evidence: {hidden: under.map((u) => u.text.trim()), written_over: written.length > 0},
        });
    }

    // Annotations painted over text: a white (or any filled) square, a stamp, free text.
    for (const a of page.annotations) {
        if (!['Square', 'FreeText', 'Stamp', 'Ink', 'Redact', 'Polygon'].includes(a.subtype) || !a.rect) continue;
        const r = {x: Math.min(a.rect[0], a.rect[2]), y: Math.min(a.rect[1], a.rect[3]), w: Math.abs(a.rect[2] - a.rect[0]), h: Math.abs(a.rect[3] - a.rect[1])};
        const under = page.items.filter((it) => overlapArea(itemRect(it), r) > 0.3 * it.w * it.size);
        if (!under.length && a.subtype !== 'FreeText') continue;
        const covering = a.subtype === 'Square' && (light(a.interior) || light(a.color));
        out.push({
            category: 'layout', code: covering ? 'annotation_covers_text' : 'annotation_over_text', severity: covering || a.subtype === 'FreeText' ? 'high' : 'warning',
            title: covering ? 'A white box annotation covers text' : `A ${a.subtype} annotation sits on the page${under.length ? ' over text' : ''}`,
            detail: 'Annotations are added on top of a document after it was made.' + (a.contents ? ` It says "${a.contents}".` : ''),
            page: page.number, box: rectBox(page, r), evidence: {subtype: a.subtype, covers: under.map((u) => u.text.trim())},
        });
    }
    return out;
}

/**
 * A quirk repeated on two or more pages (the same text, off by the same amount) is the document's template,
 * not an edit: those are dropped.
 */
function findings(doc) {
    const all = doc.pages.flatMap(pageFindings);
    const key = (f) => `${f.code}|${f.evidence.text || ''}|${f.evidence.offset_pt !== undefined ? Math.round(f.evidence.offset_pt * 10) : ''}`;
    const pages = new Map();
    for (const f of all) {
        if (!['off_baseline', 'column_misaligned'].includes(f.code)) continue;
        if (!pages.has(key(f))) pages.set(key(f), new Set());
        pages.get(key(f)).add(f.page);
    }
    return all.filter((f) => !pages.has(key(f)) || pages.get(key(f)).size < 2);
}

module.exports = {findings};
