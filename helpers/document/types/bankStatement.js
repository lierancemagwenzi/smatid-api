/**
 * Bank statements: every running balance should follow from the one before it, the closing balance from
 * the last transaction, and any totals from the transactions. A figure changed by hand breaks the chain
 * where it was changed.
 */
const {rows, parseAmount, datesIn, right, boxOf} = require('../text');
const {mismatch, close, money} = require('./common');

const HEAD = {
    debit: /^(debits?|dr|withdrawals?|money\s*out|paid\s*out|payments?)$/i,
    credit: /^(credits?|cr|deposits?|money\s*in|paid\s*in|receipts?)$/i,
    amount: /^(amount|value)$/i,
    balance: /^(balance|running\s*balance)$/i,
};

/** The table's header row on a page, and where its figure columns end. */
function header(page) {
    for (const row of rows(page.items)) {
        const cols = {};
        for (const it of row.items) {
            for (const [k, re] of Object.entries(HEAD)) if (re.test(it.text.trim())) cols[k] = it;
        }
        if (cols.balance && (cols.debit || cols.credit || cols.amount)) return {row, cols};
    }
    return null;
}

/** Which column a figure is in: the header whose edge (right, or centre) is nearest. */
function columnOf(it, cols) {
    let best = null;
    for (const [k, h] of Object.entries(cols)) {
        const d = Math.min(Math.abs(right(it) - right(h)), Math.abs((it.x + it.w / 2) - (h.x + h.w / 2)));
        if (d < 45 && (!best || d < best.d)) best = {k, d};
    }
    return best ? best.k : null;
}

function findings(doc) {
    const out = [];
    let cols = null;
    let prev = null;
    let debits = 0;
    let credits = 0;
    let lastDate = null;
    let period = null;
    const dates = [];
    let sawTable = false;
    let checked = 0;

    for (const page of doc.pages) {
        const head = header(page);
        if (head) cols = head.cols;
        for (const row of rows(page.items)) {
            const text = row.text;
            if (!period && /period|from/i.test(text)) {
                const ds = datesIn(text).filter((d) => d.date);
                if (ds.length >= 2) period = {from: ds[0].date, to: ds[1].date, row, page};
            }
            if (!cols || (head && row.y >= head.row.y)) continue;
            // A "Cr" or "Dr" printed just after a figure is its sign (FNB and others print amounts unsigned).
            const marker = (it) => {
                const next = row.items.find((o) => o.x >= right(it) - 1 && o.x - right(it) < 12 && /^(cr|dr)\.?$/i.test(o.text.trim()));
                if (next) return next.text.trim().toLowerCase().startsWith('cr') ? 1 : -1;
                const own = it.text.trim().match(/(cr|dr)\.?$/i);
                return own ? (own[1].toLowerCase() === 'cr' ? 1 : -1) : 0;
            };
            const figures = row.items.filter((it) => parseAmount(it.text)).map((it) => {
                const m = marker(it);
                const raw = parseAmount(it.text).value;
                return {it, value: m ? m * Math.abs(raw) : raw, marked: Boolean(m) || /^-|\(/.test(it.text.trim()), col: columnOf(it, cols)};
            });
            if (!figures.length) continue;
            const pick = (k) => figures.find((f) => f.col === k);
            const balance = pick('balance');

            if (/opening|brought\s*forward|b\/f|previous\s*balance/i.test(text)) {
                if (balance) prev = balance.value;
                continue;
            }
            if (/closing|carried\s*forward|c\/f/i.test(text)) {
                const closing = balance || figures[figures.length - 1];
                if (prev !== null && !close(closing.value, prev)) {
                    out.push(mismatch({code: 'closing_balance_mismatch', title: 'The closing balance doesn\'t follow from the transactions',
                        detail: `After the last transaction the balance is ${money(prev)}, but the closing balance says ${money(closing.value)}.`,
                        row: {page, row}, items: [closing.it], expected: prev, found: closing.value}));
                }
                continue;
            }
            if (/total\s*(debits?|withdrawals?|money\s*out|payments?)/i.test(text)) {
                const v = figures[figures.length - 1];
                if (sawTable && !close(v.value, debits)) {
                    out.push(mismatch({code: 'total_mismatch', title: 'Total debits don\'t add up', detail: `The debits listed add up to ${money(debits)}, but the total says ${money(v.value)}.`,
                        row: {page, row}, items: [v.it], expected: debits, found: v.value}));
                }
                continue;
            }
            if (/total\s*(credits?|deposits?|money\s*in|receipts?)/i.test(text)) {
                const v = figures[figures.length - 1];
                if (sawTable && !close(v.value, credits)) {
                    out.push(mismatch({code: 'total_mismatch', title: 'Total credits don\'t add up', detail: `The credits listed add up to ${money(credits)}, but the total says ${money(v.value)}.`,
                        row: {page, row}, items: [v.it], expected: credits, found: v.value}));
                }
                continue;
            }
            if (!balance) continue;
            const debit = pick('debit') ? Math.abs(pick('debit').value) : 0;
            const credit = pick('credit') ? Math.abs(pick('credit').value) : 0;
            let signed = pick('amount') ? pick('amount').value : credit - debit;
            // One unsigned amount column: it went whichever way makes the balance follow, if either does.
            if (pick('amount') && !pick('amount').marked && prev !== null && close(prev - Math.abs(signed), balance.value)) signed = -Math.abs(signed);
            sawTable = true;
            checked++;
            debits += pick('amount') ? Math.max(0, -signed) : debit;
            credits += pick('amount') ? Math.max(0, signed) : credit;
            if (prev !== null) {
                const expected = prev + signed;
                if (!close(expected, balance.value)) {
                    const moved = figures.filter((f) => f.col !== 'balance').map((f) => f.it);
                    out.push(mismatch({code: 'balance_mismatch', title: 'A running balance doesn\'t add up',
                        detail: `${money(prev)} ${signed >= 0 ? '+' : '−'} ${money(Math.abs(signed))} is ${money(expected)}, but the balance on this row is ${money(balance.value)}. `
                            + 'Either the transaction amount or the balance was changed.',
                        row: {page, row}, items: [...moved, balance.it], expected, found: balance.value}));
                }
            }
            prev = balance.value;
            const d = datesIn(row.items[0] ? row.items[0].text : '').find((x) => x.date);
            if (d) dates.push({date: d.date, page, row});
        }
    }

    // Transaction dates: in order (either direction), and inside the statement period.
    if (dates.length >= 3) {
        const up = dates.filter((d, i) => i && d.date >= dates[i - 1].date).length;
        const ascending = up >= (dates.length - 1) / 2;
        dates.forEach((d, i) => {
            if (!i) return;
            const ok = ascending ? d.date >= dates[i - 1].date : d.date <= dates[i - 1].date;
            if (!ok) {
                out.push({category: 'content', code: 'dates_out_of_order', severity: 'warning', title: `${d.date} is out of order`,
                    detail: `The transactions are listed ${ascending ? 'oldest first' : 'newest first'}, but this one comes after ${dates[i - 1].date}.`,
                    page: d.page.number, box: boxOf(d.page, d.row.items[0]), evidence: {date: d.date, previous: dates[i - 1].date}});
            }
        });
        lastDate = dates[dates.length - 1].date;
    }
    if (period) {
        for (const d of dates) {
            if (d.date < period.from || d.date > period.to) {
                out.push({category: 'content', code: 'date_outside_period', severity: 'warning', title: `${d.date} is outside the statement period`,
                    detail: `The statement covers ${period.from} to ${period.to}.`, page: d.page.number, box: boxOf(d.page, d.row.items[0]),
                    evidence: {date: d.date, period: {from: period.from, to: period.to}}});
            }
        }
    }
    // Most balances "wrong" means the table's layout wasn't understood, not that it was edited row by row.
    const broken = out.filter((f) => f.code === 'balance_mismatch').length;
    if (broken > 3 && broken > checked * 0.25) {
        const rest = out.filter((f) => f.code !== 'balance_mismatch' && f.code !== 'closing_balance_mismatch' && f.code !== 'total_mismatch');
        rest.push({category: 'content', code: 'statement_layout_not_followed', severity: 'info', title: 'The statement\'s table couldn\'t be followed',
            detail: `Its running balances didn't follow from its amounts on ${broken} of ${checked} rows, which means this bank's layout wasn't understood, so the balances weren't checked.`,
            page: null, box: null, evidence: {rows_checked: checked, rows_not_following: broken}});
        return {findings: rest, summary: {transactions: dates.length, balances_checked: false}};
    }
    return {findings: out, summary: {transactions: Math.max(dates.length, checked), total_debits: Math.round(debits * 100) / 100, total_credits: Math.round(credits * 100) / 100,
        closing_balance: prev, period: period ? {from: period.from, to: period.to} : null, last_date: lastDate}};
}

module.exports = {findings};
