/**
 * Payslips: the earnings add up to gross pay, the deductions to their total, and gross less deductions is
 * net pay. Year-to-date figures can't be below this period's. The pay date belongs to the pay period.
 */
const {labelledRows, find, mismatch, close, money} = require('./common');

/** The rows between a section's heading and its total (exclusive), with figures. */
function section(list, start, end) {
    const i = list.findIndex((r) => start.test(r.label));
    if (i < 0) return null;
    const j = list.findIndex((r, k) => k > i && end.test(r.label));
    if (j < 0) return null;
    return {rows: list.slice(i + 1, j).filter((r) => r.amount !== null && r.label), total: list[j]};
}

function findings(doc) {
    const out = [];
    const list = labelledRows(doc);
    const gross = find(list, /^gross(\s*(pay|salary|earnings))?\b/i);
    const totalDed = find(list, /^total\s*deductions?/i);
    const net = find(list, /^net\s*(pay|salary|amount)?/i);

    const earnings = section(list, /^earnings|^income|^payments$/i, /^gross/i);
    if (earnings && earnings.rows.length && earnings.total.amount !== null) {
        const sum = earnings.rows.reduce((a, r) => a + r.amount, 0);
        if (!close(sum, earnings.total.amount)) {
            out.push(mismatch({code: 'gross_mismatch', title: 'The earnings don\'t add up to gross pay',
                detail: `The earnings listed add up to ${money(sum)}, but gross pay says ${money(earnings.total.amount)}.`, row: earnings.total, expected: sum, found: earnings.total.amount}));
        }
    }
    const deductions = section(list, /^deductions/i, /^total\s*deductions?/i);
    if (deductions && deductions.rows.length && deductions.total.amount !== null) {
        const sum = deductions.rows.reduce((a, r) => a + Math.abs(r.amount), 0);
        if (!close(sum, Math.abs(deductions.total.amount))) {
            out.push(mismatch({code: 'deductions_mismatch', title: 'The deductions don\'t add up to their total',
                detail: `The deductions listed add up to ${money(sum)}, but the total says ${money(Math.abs(deductions.total.amount))}.`, row: deductions.total, expected: sum, found: Math.abs(deductions.total.amount)}));
        }
    }
    if (gross && totalDed && net) {
        const expected = gross.amount - Math.abs(totalDed.amount);
        if (!close(expected, net.amount)) {
            out.push(mismatch({code: 'net_pay_mismatch', title: 'Net pay isn\'t gross pay less deductions',
                detail: `${money(gross.amount)} − ${money(Math.abs(totalDed.amount))} is ${money(expected)}, but net pay says ${money(net.amount)}.`, row: net, expected, found: net.amount}));
        }
    }
    const ytd = find(list, /(year\s*to\s*date|ytd).*gross|gross.*(year\s*to\s*date|ytd)/i);
    if (ytd && gross && ytd.amount + 0.005 < gross.amount) {
        out.push(mismatch({code: 'ytd_below_period', title: 'Year-to-date gross is less than this month\'s',
            detail: `Year to date ${money(ytd.amount)} can't be less than this period's ${money(gross.amount)}.`, row: ytd, expected: gross.amount, found: ytd.amount}));
    }

    // The pay date: in the pay period, or soon after it.
    const periodRow = list.find((r) => /pay\s*period|period/i.test(r.label) && r.dates.length >= 2);
    const payRow = list.find((r) => /pay\s*date|date\s*paid|payment\s*date/i.test(r.label) && r.dates.length >= 1);
    if (periodRow && payRow) {
        const [from, to] = periodRow.dates.map((d) => d.date);
        const paid = payRow.dates[0].date;
        const limit = new Date(`${to}T00:00:00Z`);
        limit.setUTCDate(limit.getUTCDate() + 31);
        if (paid < from || paid > limit.toISOString().slice(0, 10)) {
            out.push({category: 'content', code: 'pay_date_outside_period', severity: 'warning', title: `Paid on ${paid}, outside the pay period`,
                detail: `The pay period is ${from} to ${to}.`, page: payRow.page.number, box: require('../text').boxOf(payRow.page, payRow.row.items), evidence: {paid, period: {from, to}}});
        }
    }
    return {findings: out, summary: {gross: gross && gross.amount, total_deductions: totalDed && Math.abs(totalDed.amount), net: net && net.amount}};
}

module.exports = {findings};
