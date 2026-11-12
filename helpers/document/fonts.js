/**
 * Fonts. A document from a bank's or payroll system uses a few fonts consistently. Changing a figure in a PDF
 * editor usually types it in whatever font the editor has, so the changed figure stands out: a font used for
 * one or two numbers and nothing else, or the same font embedded a second time.
 */
const {boxOf, isNumeric, rows, parseAmount, datesIn} = require('./text');

// "ABCDEF+Arial-BoldMT" → subset "ABCDEF", base "Arial-BoldMT", family "arial".
function parts(name) {
    const m = String(name || '').match(/^([A-Z]{6})\+(.+)$/);
    const base = m ? m[2] : String(name || '');
    const family = base.replace(/[-,].*$/, '').replace(/(MT|PS|Std|Pro)$/i, '').replace(/(Bold|Italic|Oblique|Regular)$/i, '').toLowerCase();
    return {subset: m ? m[1] : null, base, family};
}

const meaningful = (s) => isNumeric(s) || datesIn(s).length > 0 || /^[A-Z][A-Z .'-]{2,}$/.test(String(s).trim());

function summary(fonts) {
    return Object.entries(fonts).map(([key, f]) => ({key, name: f.name, ...parts(f.name), embedded: f.embedded, items: f.items, chars: f.chars, pages: f.pages}))
        .sort((a, b) => b.chars - a.chars);
}

function findings(doc) {
    const out = [];
    const list = summary(doc.fonts);
    const totalChars = list.reduce((a, f) => a + f.chars, 0) || 1;
    const families = new Map();
    for (const f of list) families.set(f.family, (families.get(f.family) || 0) + f.chars);
    const allItems = doc.pages.flatMap((p) => p.items.map((it) => ({...it, page: p})));

    // A family used for only a handful of pieces of text, which are figures, dates or names, when the
    // document's other text uses other families.
    for (const [family, chars] of families) {
        const fontsOf = list.filter((f) => f.family === family);
        const items = allItems.filter((it) => fontsOf.some((f) => f.key === it.font));
        const share = chars / totalChars;
        if (families.size < 2 || items.length > 4 || share > 0.06) continue;
        const suspect = items.filter((it) => meaningful(it.text));
        if (!suspect.length) continue;
        // A bigger size is a heading or a logo, not a typed-over figure.
        const bodySize = median(allItems.map((it) => it.size));
        if (suspect.every((it) => it.size > bodySize * 1.4)) continue;
        for (const it of suspect) {
            out.push({
                category: 'fonts', code: 'font_out_of_place', severity: isNumeric(it.text) || datesIn(it.text).length ? 'high' : 'warning',
                title: `"${it.text.trim()}" is in a font used nowhere else`,
                detail: `It's set in ${fontsOf[0].base}; the rest of the document uses ${[...families.keys()].filter((f) => f !== family).join(', ')}. A figure typed over in an editor looks like this.`,
                page: it.page.number, box: boxOf(it.page, it), evidence: {text: it.text.trim(), font: fontsOf[0].name},
            });
        }
    }

    // The same font embedded more than once (two different subset prefixes): a second copy came in with an edit.
    const byBase = new Map();
    for (const f of list.filter((x) => x.subset && x.embedded !== false)) {
        if (!byBase.has(f.base)) byBase.set(f.base, []);
        byBase.get(f.base).push(f);
    }
    for (const [base, copies] of byBase) {
        if (copies.length < 2) continue;
        const smallest = copies.reduce((a, b) => (a.chars <= b.chars ? a : b));
        const items = allItems.filter((it) => it.font === smallest.key).slice(0, 8);
        out.push({
            category: 'fonts', code: 'font_embedded_twice', severity: 'high', title: `${base} is embedded ${copies.length} times`,
            detail: `The same font was added to the file more than once (${copies.map((c) => c.subset).join(', ')}). The smaller copy is used for ${smallest.items} piece${smallest.items === 1 ? '' : 's'} of text, which were probably added later.`,
            page: items[0] ? items[0].page.number : null, box: items[0] ? boxOf(items[0].page, items[0]) : null,
            evidence: {font: base, subsets: copies.map((c) => ({subset: c.subset, items: c.items})), text: items.map((i) => i.text.trim())},
        });
    }

    const embedded = list.filter((f) => f.embedded === true);
    const notEmbedded = list.filter((f) => f.embedded === false);
    if (embedded.length && notEmbedded.length && notEmbedded.some((f) => f.chars / totalChars < 0.05)) {
        out.push({category: 'fonts', code: 'font_embedding_mixed', severity: 'info', title: 'Some fonts are embedded and some aren\'t',
            detail: `Not embedded: ${notEmbedded.map((f) => f.base).join(', ')}.`, evidence: {embedded: embedded.map((f) => f.base), not_embedded: notEmbedded.map((f) => f.base)}});
    }

    // A figure in a different size from the rest of its row.
    for (const page of doc.pages) {
        for (const row of rows(page.items)) {
            const numbers = row.items.filter((it) => parseAmount(it.text));
            if (numbers.length < 2) continue;
            const size = median(numbers.map((it) => it.size));
            for (const it of numbers) {
                if (Math.abs(it.size - size) / size > 0.08) {
                    out.push({category: 'fonts', code: 'font_size_out_of_line', severity: 'warning', title: `"${it.text.trim()}" is a different size from its row`,
                        detail: `${it.size.toFixed(1)} pt, where the other figures on the row are ${size.toFixed(1)} pt.`,
                        page: page.number, box: boxOf(page, it), evidence: {text: it.text.trim(), size: it.size, row_size: size}});
                }
            }
        }
    }
    return out;
}

function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
}

module.exports = {summary, findings, parts, median};
