/**
 * What the document says, checked against itself: the same field (name, account number, ID number, address)
 * given differently in two places, dates that can't exist, and Zimbabwean ID numbers whose check letter is
 * wrong. Then the arithmetic for its type (types/*.js).
 */
const {rows, datesIn, boxOf} = require('./text');
const zw = require('../idcard/countries/zw');

/** Labels whose value should be the same wherever they appear. First match wins, so numbers go before names. */
const FIELDS = [
    {key: 'account_number', label: /^(account|acc|a\/c)\.?\s*(number|no\.?|#)\s*:?/i},
    {key: 'employee_number', label: /^(employee|staff|payroll)\s*(number|no\.?|#|id)\s*:?/i},
    {key: 'id_number', label: /^(national\s*)?id\s*(number|no\.?)\s*:?/i},
    {key: 'name', label: /^(account\s*(holder|name)|customer\s*name|employee(\s*name)?|name)\s*:/i},
    {key: 'address', label: /^((service|postal|physical|residential)\s*)?address\s*:?/i},
];

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Every labelled value: the label and its value on one piece of text ("Name: X"), or the value to its right. */
function labelledValues(page) {
    const out = [];
    for (const row of rows(page.items)) {
        row.items.forEach((it, i) => {
            const text = it.text.trim();
            for (const f of FIELDS) {
                const m = text.match(f.label);
                if (!m) continue;
                // "Account number" is also matched by the looser "name"-style labels; the first field wins.
                let value = text.slice(m[0].length).trim();
                let valueItems = [it];
                if (!value) {
                    const next = row.items[i + 1];
                    if (!next) break;
                    value = next.text.trim();
                    valueItems = [next];
                }
                if (value && value.length <= 80) out.push({field: f.key, value, items: valueItems, page});
                break;
            }
        });
    }
    return out;
}

function fieldFindings(doc) {
    const out = [];
    const all = doc.pages.flatMap(labelledValues);
    const byField = new Map();
    for (const v of all) {
        if (!byField.has(v.field)) byField.set(v.field, []);
        byField.get(v.field).push(v);
    }
    for (const [field, values] of byField) {
        const distinct = [...new Map(values.map((v) => [norm(v.value), v])).values()];
        if (distinct.length < 2) continue;
        // "TENDAI MOYO" and "MOYO TENDAI" are the same name.
        if (field === 'name' && new Set(distinct.map((v) => norm(v.value.split(/\s+/).sort().join('')))).size < 2) continue;
        const [first, ...rest] = distinct;
        for (const other of rest) {
            out.push({
                category: 'content', code: 'field_mismatch', severity: 'high',
                title: `The ${field.replace(/_/g, ' ')} differs: "${first.value}" and "${other.value}"`,
                detail: `The document gives its ${field.replace(/_/g, ' ')} as "${first.value}" (page ${first.page.number}) and "${other.value}" (page ${other.page.number}).`,
                page: other.page.number, box: boxOf(other.page, other.items),
                evidence: {field, values: distinct.map((v) => ({value: v.value, page: v.page.number}))},
            });
        }
    }
    return out;
}

function dateFindings(doc) {
    const out = [];
    for (const page of doc.pages) {
        for (const it of page.items) {
            for (const d of datesIn(it.text)) {
                if (d.invalid) {
                    out.push({category: 'content', code: 'impossible_date', severity: 'high', title: `${d.text} isn't a real date`,
                        detail: 'No calendar has this date. A system wouldn\'t print it.', page: page.number, box: boxOf(page, it), evidence: {text: d.text}});
                }
            }
        }
    }
    return out;
}

function idNumberFindings(doc) {
    const out = [];
    for (const page of doc.pages) {
        for (const row of rows(page.items)) {
            // Only a number written the way ID numbers are (with a real check letter), so account and phone
            // numbers aren't taken for one.
            if (!/(?<![\dA-Z])\d{2}[- ]?\d{6,7}\s?[A-Z]\s?\d{2}(?![\d])/.test(row.text)) continue;
            const id = zw.parseIdNumber(row.text);
            if (id && !id.check_letter_valid) {
                out.push({category: 'content', code: 'id_number_check_letter', severity: 'warning',
                    title: `The ID number ${id.value} has the wrong check letter`,
                    detail: `A Zimbabwean ID number with that district and serial ends in ${id.expected_check_letter}, not ${id.check_letter}.`,
                    page: page.number, box: boxOf(page, row.items), evidence: {id_number: id.value, expected_check_letter: id.expected_check_letter}});
            }
        }
    }
    return out;
}

// ----- Which kind of document it is -----

const KINDS = {
    bank_statement: [/statement/i, /opening balance/i, /closing balance/i, /\bdebit/i, /\bcredit/i, /\bbalance\b/i, /account (number|no)/i, /withdrawal|deposit/i],
    payslip: [/pay ?slip|pay ?advice/i, /net pay|net salary/i, /gross/i, /\bpaye\b|income tax/i, /earnings/i, /deductions/i, /employee/i, /nssa|pension/i],
    utility_bill: [/\bbill\b|invoice/i, /amount due|total due/i, /billing period/i, /previous balance/i, /meter|reading|kwh/i, /water|electricity|zesa|refuse|sewerage/i, /account name/i, /service address/i],
};

function detectType(doc) {
    const text = doc.pages.map((p) => p.items.map((i) => i.text).join(' ')).join(' ');
    let best = {type: 'other', score: 0};
    for (const [type, words] of Object.entries(KINDS)) {
        const score = words.filter((re) => re.test(text)).length;
        if (score > best.score) best = {type, score};
    }
    return best.score >= 3 ? best.type : 'other';
}

function findings(doc) {
    return [...fieldFindings(doc), ...dateFindings(doc), ...idNumberFindings(doc)];
}

module.exports = {findings, detectType, labelledValues, KINDS};
