/** Rows as "label … figure", in reading order across pages: what the payslip and bill sums are checked from. */
const {rows, parseAmount, boxOf, datesIn} = require('../text');

const cents = (v) => Math.round(v * 100);
const close = (a, b) => Math.abs(cents(a) - cents(b)) <= 1;

function labelledRows(doc) {
    const out = [];
    for (const page of doc.pages) {
        for (const row of rows(page.items)) {
            const amounts = row.items.filter((it) => parseAmount(it.text));
            const words = row.items.filter((it) => !parseAmount(it.text));
            const last = amounts[amounts.length - 1];
            out.push({
                page, row,
                label: words.map((w) => w.text.trim()).join(' '),
                amount: last ? parseAmount(last.text).value : null,
                amountItem: last || null,
                amounts: amounts.map((it) => ({item: it, value: parseAmount(it.text).value})),
                dates: datesIn(row.text).filter((d) => d.date),
            });
        }
    }
    return out;
}

/** The first row whose label matches, with a figure. */
const find = (list, re) => list.find((r) => re.test(r.label) && r.amount !== null) || null;

function mismatch({code, title, detail, row, items, expected, found}) {
    return {
        category: 'content', code, severity: 'high', title, detail,
        page: row.page.number, box: boxOf(row.page, items || (row.amountItem ? [row.amountItem] : row.row.items)),
        evidence: {expected: Math.round(expected * 100) / 100, found: Math.round(found * 100) / 100, difference: Math.round((found - expected) * 100) / 100},
    };
}

const money = (v) => (Math.round(v * 100) / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

module.exports = {labelledRows, find, mismatch, close, money, cents};
