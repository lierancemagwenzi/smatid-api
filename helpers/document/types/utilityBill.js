/**
 * Utility bills: the charges add up to the current total, and the previous balance less payments plus the
 * charges is what's due. The billing period runs forwards, and the bill is dated within or after it.
 */
const {labelledRows, find, mismatch, close, money} = require('./common');
const {boxOf} = require('../text');

function findings(doc) {
    const out = [];
    const list = labelledRows(doc);
    const previous = find(list, /^(previous|opening|last)\s*(balance|bill|amount)|^balance\s*(b\/f|brought\s*forward)/i);
    const payments = list.filter((r) => /payments?\s*(received|made)?|paid/i.test(r.label) && r.amount !== null);
    const total = find(list, /^total\s*(current\s*)?(charges|this\s*(month|period))/i);
    const due = find(list, /amount\s*(due|payable)|total\s*(due|payable)|balance\s*due|please\s*pay/i);

    // The charges: the rows between the last payment (or previous balance) and the total.
    if (total) {
        const startAt = Math.max(list.indexOf(previous), ...payments.map((p) => list.indexOf(p)));
        const charges = list.slice(startAt + 1, list.indexOf(total)).filter((r) => r.amount !== null && r.label);
        if (charges.length) {
            const sum = charges.reduce((a, r) => a + r.amount, 0);
            if (!close(sum, total.amount)) {
                out.push(mismatch({code: 'charges_mismatch', title: 'The charges don\'t add up to their total',
                    detail: `The charges listed add up to ${money(sum)}, but the total says ${money(total.amount)}.`, row: total, expected: sum, found: total.amount}));
            }
        }
    }
    if (due && total && previous) {
        // Payments are printed either as negatives or as positive amounts under a "payments" label.
        const paid = payments.reduce((a, p) => a + Math.abs(p.amount), 0);
        const expected = previous.amount - paid + total.amount;
        if (!close(expected, due.amount)) {
            out.push(mismatch({code: 'amount_due_mismatch', title: 'The amount due doesn\'t add up',
                detail: `${money(previous.amount)} previous − ${money(paid)} paid + ${money(total.amount)} charges is ${money(expected)}, but the amount due says ${money(due.amount)}.`,
                row: due, expected, found: due.amount}));
        }
    }

    const periodRow = list.find((r) => /billing\s*period|period|from/i.test(r.label) && r.dates.length >= 2);
    if (periodRow) {
        const [from, to] = periodRow.dates.map((d) => d.date);
        if (from > to) {
            out.push({category: 'content', code: 'period_backwards', severity: 'high', title: 'The billing period ends before it starts',
                detail: `${from} to ${to}.`, page: periodRow.page.number, box: boxOf(periodRow.page, periodRow.row.items), evidence: {from, to}});
        }
        const billRow = list.find((r) => /bill\s*date|date\s*of\s*(bill|issue)|invoice\s*date|statement\s*date/i.test(r.label) && r.dates.length);
        if (billRow && billRow.dates[0].date < from) {
            out.push({category: 'content', code: 'bill_before_period', severity: 'warning', title: 'The bill is dated before its billing period',
                detail: `Dated ${billRow.dates[0].date}, for ${from} to ${to}.`, page: billRow.page.number, box: boxOf(billRow.page, billRow.row.items),
                evidence: {bill_date: billRow.dates[0].date, period: {from, to}}});
        }
    }
    return {findings: out, summary: {previous: previous && previous.amount, total_charges: total && total.amount, amount_due: due && due.amount}};
}

module.exports = {findings};
