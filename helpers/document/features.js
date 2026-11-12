/**
 * What the tamper classifier (model.js) is given about a document: a fixed list of numbers, built from the
 * findings and from measurements the rules only use past a threshold (how far the worst figure is off its
 * row, how far off its column), so a model can learn from small signs the rules let through.
 *
 * Bump VERSION whenever the list changes: a model trained on another list can't be used.
 */
const {rows, right, parseAmount} = require('./text');
const {median} = require('./fonts');

const VERSION = 1;

const NAMES = [
    'bias',
    'editor_tool', 'office_tool', 'hours_created_to_modified', 'metadata_disagrees', 'metadata_missing',
    'incremental_updates', 'producer_changed', 'changed_after_signing',
    'font_families', 'font_out_of_place', 'font_embedded_twice', 'font_size_out_of_line', 'minor_font_share',
    'max_baseline_offset', 'mean_baseline_offset', 'off_baseline', 'max_column_offset', 'column_misaligned',
    'text_over_text', 'text_covered', 'annotations_over_text',
    'sums_wrong', 'field_mismatch', 'date_problems',
    'pages', 'scanned', 'bank_statement', 'payslip', 'utility_bill',
    'image_tamper_score', 'image_tamper_regions', 'image_ela_outliers',
];

const SUMS = new Set(['balance_mismatch', 'closing_balance_mismatch', 'total_mismatch', 'gross_mismatch', 'deductions_mismatch',
    'net_pay_mismatch', 'ytd_below_period', 'charges_mismatch', 'amount_due_mismatch']);
const DATES = new Set(['impossible_date', 'dates_out_of_order', 'date_outside_period', 'period_backwards', 'bill_before_period', 'pay_date_outside_period']);

/** How far pieces of text sit off their row's baseline, in points: {max, mean} over rows of 3+ pieces. */
function baselineOffsets(doc) {
    const offs = [];
    for (const page of doc.pages) {
        for (const row of rows(page.items)) {
            if (row.items.length < 3) continue;
            for (const it of row.items) if (it.size >= row.size * 0.8) offs.push(Math.min(Math.abs(it.y - row.y), row.size * 0.45));
        }
    }
    return {max: offs.length ? Math.max(...offs) : 0, mean: offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : 0};
}

/** The worst right-edge disagreement within right-aligned figure columns, in points. */
function columnOffset(doc) {
    let worst = 0;
    for (const page of doc.pages) {
        const cols = [];
        for (const it of page.items.filter((x) => parseAmount(x.text))) {
            const col = cols.find((c) => Math.abs(c.right - right(it)) <= 6);
            if (col) {
                col.items.push(it);
                col.right = median(col.items.map(right));
            } else cols.push({right: right(it), items: [it]});
        }
        for (const col of cols.filter((c) => c.items.length >= 4)) {
            for (const it of col.items) worst = Math.max(worst, Math.abs(right(it) - col.right));
        }
    }
    return Math.min(worst, 6);
}

/**
 * The feature row for one analysed document. `image` is the scanned-page analysis (imageForensics.js),
 * when there was one.
 */
function build({doc, findings, meta, struct, docType, image = null}) {
    const count = (code) => findings.filter((f) => f.code === code).length;
    const has = (code) => (count(code) ? 1 : 0);
    const hours = meta.created && meta.modified ? Math.max(0, (meta.modified - meta.created) / 3600000) : 0;
    const chars = Object.values(doc.fonts).map((f) => f.chars);
    const total = chars.reduce((a, b) => a + b, 0) || 1;
    const families = new Set(Object.values(doc.fonts).map((f) => String(f.name).replace(/^[A-Z]{6}\+/, '').replace(/[-,].*$/, '').toLowerCase()));
    const base = baselineOffsets(doc);
    const values = {
        bias: 1,
        editor_tool: has('pdf_editor') || has('image_editor'),
        office_tool: has('office_software'),
        hours_created_to_modified: Math.log1p(hours),
        metadata_disagrees: has('metadata_disagrees') || has('metadata_dates_disagree'),
        metadata_missing: has('metadata_missing'),
        incremental_updates: Math.min(5, struct.updates),
        producer_changed: has('producer_changed'),
        changed_after_signing: has('changed_after_signing'),
        font_families: Math.min(8, families.size),
        font_out_of_place: Math.min(5, count('font_out_of_place')),
        font_embedded_twice: has('font_embedded_twice'),
        font_size_out_of_line: Math.min(5, count('font_size_out_of_line')),
        minor_font_share: chars.length > 1 ? Math.min(...chars) / total : 0,
        max_baseline_offset: base.max,
        mean_baseline_offset: base.mean,
        off_baseline: Math.min(5, count('off_baseline')),
        max_column_offset: columnOffset(doc),
        column_misaligned: Math.min(5, count('column_misaligned')),
        text_over_text: Math.min(5, count('text_over_text')),
        text_covered: Math.min(5, count('text_covered')),
        annotations_over_text: Math.min(5, count('annotation_covers_text') + count('annotation_over_text')),
        sums_wrong: Math.min(5, findings.filter((f) => SUMS.has(f.code)).length),
        field_mismatch: Math.min(5, count('field_mismatch')),
        date_problems: Math.min(5, findings.filter((f) => DATES.has(f.code)).length),
        pages: Math.log1p(doc.numPages),
        scanned: doc.pages.every((p) => p.items.length === 0 && p.images.length > 0) ? 1 : 0,
        bank_statement: docType === 'bank_statement' ? 1 : 0,
        payslip: docType === 'payslip' ? 1 : 0,
        utility_bill: docType === 'utility_bill' ? 1 : 0,
        image_tamper_score: image ? image.max_score : 0,
        image_tamper_regions: image ? Math.min(5, image.regions) : 0,
        image_ela_outliers: image ? Math.min(5, image.ela_outliers) : 0,
    };
    return {version: VERSION, names: NAMES, values: NAMES.map((n) => Math.round(values[n] * 10000) / 10000)};
}

module.exports = {build, NAMES, VERSION};
