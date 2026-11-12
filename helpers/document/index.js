/**
 * The document proofreader: reads a PDF and reports what looks wrong with it.
 *
 *   const report = await document.analyse(bytes, {type: 'bank_statement'});
 *
 * The checks (each its own file) look at the file's history (structure.js), what it says about itself
 * (metadata.js), its fonts (fonts.js), how its text is laid out (layout.js), and what it says (content.js,
 * and types/* for the sums on statements, payslips and bills). Each finding has a severity; together they
 * make a 0-100 score and a verdict.
 */
const pdf = require('./pdf');
const structure = require('./structure');
const metadata = require('./metadata');
const fonts = require('./fonts');
const layout = require('./layout');
const content = require('./content');
const featureList = require('./features');
const model = require('./model');
const imageForensics = require('./imageForensics');

const TYPES = {
    bank_statement: require('./types/bankStatement'),
    payslip: require('./types/payslip'),
    utility_bill: require('./types/utilityBill'),
};
const DOC_TYPES = [...Object.keys(TYPES), 'other'];

const WEIGHT = {info: 0, warning: 12, high: 35};
const CATEGORY_CAP = 70;

// What a model marks always deserves a person's look, however lightly it scores.
const REVIEW_CODES = new Set(['image_edited_region', 'model_suspects_tampering']);

/** clean: nothing of note. review: something a person should look at. suspicious: signs of tampering. */
function verdictOf(findings, score) {
    if (findings.some((f) => f.severity === 'high') || score >= 60) return 'suspicious';
    if (score >= 25 || findings.some((f) => REVIEW_CODES.has(f.code))) return 'review';
    return 'clean';
}

function score(findings) {
    const byCategory = {};
    for (const f of findings) byCategory[f.category] = Math.min(CATEGORY_CAP, (byCategory[f.category] || 0) + WEIGHT[f.severity]);
    return Math.min(100, Object.values(byCategory).reduce((a, b) => a + b, 0));
}

/** Highest severity first, then by page. Repeats of the same finding at the same place are dropped. */
function tidy(findings) {
    const seen = new Set();
    const rank = {high: 0, warning: 1, info: 2};
    return findings
        .filter((f) => {
            const k = `${f.code}|${f.page || ''}|${(f.box || []).join(',')}|${f.title}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.page || 0) - (b.page || 0))
        .map((f) => ({page: null, box: null, evidence: {}, ...f}));
}

/**
 * Analyses a PDF. `type` (one of DOC_TYPES) skips detection. Throws pdf.PdfError for a file that can't be
 * read (pdf_encrypted, pdf_unreadable, too_many_pages, pdf_timeout).
 */
async function analyse(bytes, {type = null, now = new Date()} = {}) {
    const doc = await pdf.read(bytes);
    const struct = structure.analyse(bytes);
    const detected = content.detectType(doc);
    const docType = DOC_TYPES.includes(type) ? type : detected;
    const meta = metadata.summary(doc.info, doc.xmp, struct);

    let typeResult = {findings: [], summary: null};
    if (TYPES[docType]) typeResult = TYPES[docType].findings(doc);

    const text = doc.pages.reduce((a, p) => a + p.items.length, 0);
    const imageOnly = doc.pages.every((p) => p.items.length === 0 && p.images.length > 0);
    const ruled = [
        ...structure.findings(struct),
        ...metadata.findings(meta, {docType, now}),
        ...fonts.findings(doc),
        ...layout.findings(doc),
        ...content.findings(doc),
        ...typeResult.findings,
    ];
    if (imageOnly) {
        ruled.push({category: 'content', code: 'scanned_image_only', severity: 'info', title: 'The pages are pictures, with no text in them',
            detail: 'It\'s a scan or a photo. The font, layout and sum checks need text, so they couldn\'t run; the picture itself was examined instead.', page: null, box: null, evidence: {}});
    }
    // Scanned pages: where the picture was changed (imageForensics.js).
    const image = doc.pages.some((p) => p.scans && p.scans.length) ? await imageForensics.analyse(doc) : null;
    if (image) ruled.push(...image.findings);

    // The trained model, when there is one: it sees the same measurements, and can only add to the rules'
    // findings, never clear them.
    const feats = featureList.build({doc, findings: ruled, meta, struct, docType, image});
    const assessment = model.assess(feats.values);
    if (assessment && assessment.active && assessment.tampered_probability >= 0.7) {
        const pct = Math.round(assessment.tampered_probability * 100);
        ruled.push({category: 'model', code: 'model_suspects_tampering', severity: assessment.tampered_probability >= 0.9 ? 'high' : 'warning',
            title: `The trained model rates this ${pct}% likely to have been changed`,
            detail: 'It weighs all the signs together, as learned from documents already confirmed genuine or doctored.',
            page: null, box: null, evidence: {probability: assessment.tampered_probability, model_version: assessment.version}});
    }
    const findings = tidy(ruled);
    const total = score(findings);

    return {
        verdict: verdictOf(findings, total),
        score: total,
        document: {
            type: docType,
            type_detected: detected,
            pages: doc.numPages,
            page_sizes: doc.pages.map((p) => [Math.round(p.width), Math.round(p.height)]),
            text_items: text,
            scanned: imageOnly,
        },
        findings,
        counts: {
            high: findings.filter((f) => f.severity === 'high').length,
            warning: findings.filter((f) => f.severity === 'warning').length,
            info: findings.filter((f) => f.severity === 'info').length,
        },
        metadata: meta,
        structure: {
            revisions: struct.revisions,
            incremental_updates: struct.updates,
            linearized: struct.linearized,
            signed: struct.signatures.length > 0,
            javascript: struct.javascript,
            embedded_files: struct.embedded_files,
            forms: struct.forms,
            producers: struct.producers,
        },
        fonts: fonts.summary(doc.fonts).map(({name, base, subset, embedded, items, pages}) => ({name, base, subset, embedded, items, pages})),
        figures: typeResult.summary,
        model: assessment,
        image: image ? {pages_examined: doc.pages.filter((p) => p.scans && p.scans.length).length, forgery_model: image.model.used ? image.model.version : null,
            highest_score: image.model.used ? image.max_score : null} : null,
        // Not part of the report clients see (the controller keeps it apart): what the model is trained on.
        features: feats,
    };
}

module.exports = {analyse, DOC_TYPES, PdfError: pdf.PdfError, score, verdictOf};
