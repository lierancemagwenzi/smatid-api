/**
 * The document proofreader: a client sends a PDF and gets back what looks wrong with it (helpers/document).
 * The file is read in memory and not kept; the report is, with the file's SHA-256, so the client can look it
 * up again and see whether the same file was checked before.
 */
const crypto = require('crypto');
const db = require('../models');
const {Op} = require('sequelize');
const documentCheck = require('../helpers/document');
const documentModel = require('../helpers/document/model');
const {listQuery} = require('../helpers/adminListHelper');

const CHECK_ID = /^dc_[A-Za-z0-9_-]{32}$/;
const MAX_BYTES = (Number(process.env.DOC_MAX_MB) || 15) * 1024 * 1024;

/** The upload: base64 (with or without a data: prefix) to bytes, or null. */
function decode(file) {
    if (typeof file !== 'string' || !file) return null;
    const b64 = file.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
    return Buffer.from(b64, 'base64');
}

const isPdf = (bytes) => bytes.length > 64 && bytes.slice(0, 1024).toString('latin1').includes('%PDF-');

async function save(req, bytes, analysed, sha256) {
    const {features, ...report} = analysed;
    const body = req.body || {};
    return db.document_check.create({
        public_id: 'dc_' + crypto.randomBytes(24).toString('base64url'),
        client_id: req.client.id,
        reference: typeof body.reference === 'string' ? body.reference.slice(0, 255) : null,
        filename: typeof body.filename === 'string' ? body.filename.replace(/[\r\n]/g, ' ').slice(0, 255) : null,
        size: bytes.length,
        sha256,
        pages: report.document.pages,
        doc_type: report.document.type,
        verdict: report.verdict,
        score: report.score,
        report,
        features: features || null,
    });
}

/**
 * POST {file: base64 PDF, filename?, type?, reference?} → 201 the report. Problems with the file itself are
 * 4xx and not charged: file_required, not_a_pdf (400), file_too_large (413), pdf_encrypted, pdf_unreadable,
 * too_many_pages (422).
 */
exports.Check = async (req, res) => {
    const body = req.body || {};
    if (body.file === undefined || body.file === null || body.file === '') return res.status(400).json({error: 'file_required'});
    const bytes = decode(body.file);
    if (!bytes) return res.status(400).json({error: 'invalid_file', detail: 'Send the PDF as base64 in "file".'});
    if (bytes.length > MAX_BYTES) return res.status(413).json({error: 'file_too_large', max_bytes: MAX_BYTES});
    if (!isPdf(bytes)) return res.status(400).json({error: 'not_a_pdf'});
    if (body.type !== undefined && body.type !== null && !documentCheck.DOC_TYPES.includes(body.type)) {
        return res.status(400).json({error: 'invalid_type', types: documentCheck.DOC_TYPES});
    }

    let report;
    try {
        report = await documentCheck.analyse(bytes, {type: body.type || null});
    } catch (err) {
        if (err instanceof documentCheck.PdfError) return res.status(422).json({error: err.code, detail: err.message});
        console.error('Document check failed:', err.message);
        return res.status(500).json({error: 'document_check_failed'});
    }

    try {
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const seen = await db.document_check.count({where: {client_id: req.client.id, sha256}});
        const check = await save(req, bytes, report, sha256);
        return res.status(201).json({...check.toPublic(), checked_before: seen});
    } catch (err) {
        console.error('Document check save failed:', err.message);
        return res.status(500).json({error: 'document_check_failed'});
    }
};

/** A check this client ran earlier. */
exports.Show = async (req, res) => {
    try {
        if (!CHECK_ID.test(req.params.checkId)) return res.status(404).json({error: 'check_not_found'});
        const check = await db.document_check.findOne({where: {public_id: req.params.checkId, client_id: req.client.id}});
        if (!check) return res.status(404).json({error: 'check_not_found'});
        return res.json(check.toPublic());
    } catch (err) {
        console.error('Document check lookup failed:', err.message);
        return res.status(500).json({error: 'check_lookup_failed'});
    }
};

// ----- Admin: labelling checks for the tamper classifier, and the classifier itself -----

/** `?labelled=0|1&verdict=suspicious&client_id=7&page=1&per_page=25`, newest first. */
exports.AdminList = async (req, res) => {
    const {where, page, perPage, limit, offset} = listQuery(req.query);
    delete where.status;
    if (['clean', 'review', 'suspicious'].includes(req.query.verdict)) where.verdict = req.query.verdict;
    if (req.query.labelled === '1') where.labelled_at = {[Op.ne]: null};
    if (req.query.labelled === '0') where.labelled_at = null;
    try {
        const {rows, count} = await db.document_check.findAndCountAll({
            where, order: [['created_at', 'DESC']], limit, offset, include: [{model: db.client, attributes: ['id', 'name']}],
        });
        return res.json({
            checks: rows.map((c) => {
                const r = c.report || {};
                return {
                    check_id: c.public_id, client: c.client, filename: c.filename, reference: c.reference, doc_type: c.doc_type, pages: c.pages,
                    verdict: c.verdict, score: c.score, counts: r.counts || null, top: (r.findings || []).slice(0, 2).map((f) => f.title),
                    model: r.model || null, label: c.label || null, labelled_at: c.labelled_at, created_at: c.createdAt,
                };
            }),
            page, per_page: perPage, total: count,
        });
    } catch (err) {
        console.error('Document check admin list failed:', err.message);
        return res.status(500).json({error: 'check_list_failed'});
    }
};

const findAny = (req) => (CHECK_ID.test(req.params.checkId)
    ? db.document_check.findOne({where: {public_id: req.params.checkId}, include: [{model: db.client, attributes: ['id', 'name']}]})
    : null);

exports.AdminShow = async (req, res) => {
    try {
        const check = await findAny(req);
        if (!check) return res.status(404).json({error: 'check_not_found'});
        return res.json({check: {...check.toAdmin(), client: check.client}});
    } catch (err) {
        console.error('Document check admin lookup failed:', err.message);
        return res.status(500).json({error: 'check_lookup_failed'});
    }
};

/**
 * What the document really was, from an admin who confirmed it with the issuer or the applicant:
 * {verdict: 'genuine'|'doctored', note?}. Labelled checks are what the tamper classifier is trained on.
 * `verdict: null` takes a label off.
 */
exports.AdminLabel = async (req, res) => {
    const body = req.body || {};
    if (body.verdict !== null && !documentModel.CLASSES.includes(body.verdict)) {
        return res.status(400).json({error: 'invalid_verdict', verdicts: documentModel.CLASSES});
    }
    if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) {
        return res.status(400).json({error: 'invalid_note'});
    }
    try {
        const check = await findAny(req);
        if (!check) return res.status(404).json({error: 'check_not_found'});
        await check.update(body.verdict === null
            ? {label: null, labelled_by: null, labelled_at: null}
            : {label: {verdict: body.verdict, note: body.note || null}, labelled_by: req.admin ? req.admin.id : null, labelled_at: new Date()});
        return res.json({check: {...check.toAdmin(), client: check.client}});
    } catch (err) {
        console.error('Document check label failed:', err.message);
        return res.status(500).json({error: 'label_failed'});
    }
};

/** The classifier (version, whether it's used, how it scored against the rules) and the labelled counts. */
exports.AdminModel = async (req, res) => {
    try {
        const [checks, labelled, doctored] = await Promise.all([
            db.document_check.count(),
            db.document_check.count({where: {labelled_at: {[Op.ne]: null}}}),
            db.document_check.count({where: {[Op.and]: [
                {labelled_at: {[Op.ne]: null}},
                db.sequelize.where(db.sequelize.fn('JSON_UNQUOTE', db.sequelize.fn('JSON_EXTRACT', db.sequelize.col('label'), '$.verdict')), 'doctored'),
            ]}}),
        ]);
        return res.json({checks, labelled, doctored, model: documentModel.summary()});
    } catch (err) {
        console.error('Document model summary failed:', err.message);
        return res.status(500).json({error: 'model_summary_failed'});
    }
};

exports.AdminReloadModel = (req, res) => {
    documentModel.reload();
    return res.json({model: documentModel.summary()});
};

module.exports.CHECK_ID = CHECK_ID;
