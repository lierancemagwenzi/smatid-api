const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Op} = require('sequelize');
const idcard = require('../helpers/idcard');
const {listQuery} = require('../helpers/adminListHelper');
const ocrInput = require('../helpers/idcard/ocrInput');
const idModel = require('../helpers/idcard/model');
const scanHelper = require('../helpers/scanHelper');
const faceMatchHelper = require('../helpers/passport/faceMatchHelper');
const {LIVENESS_ID} = require('./PassportController');
const db = require('../models');

const SCAN_ID = /^ic_[A-Za-z0-9_-]{32}$/;
const storageDir = () => process.env.ID_CARD_STORAGE_DIR || path.join(__dirname, '..', 'storage', 'id-card');

const unsupported = (res) => res.status(400).json({error: 'unsupported_country', supported: idcard.supported().map((c) => c.code)});

/**
 * A scanned ID card: the country, the text the app read off the front (lines with their boxes), and the
 * picture it took. The server reads the fields, with the country's trained model if there is a usable one
 * and its rules if not. No ID number found answers 422 (not charged), so the app can scan again.
 */
exports.Scan = async (req, res) => {
    const body = req.body || {};
    const reference = scanHelper.reference(body.reference);
    if (reference === false) return res.status(400).json({error: 'invalid_reference'});
    const profile = idcard.profile(body.country);
    if (!profile) return unsupported(res);
    const image = scanHelper.decodeImage(body.image);
    if (!image) return res.status(400).json({error: 'invalid_image'});
    let lines;
    try {
        lines = ocrInput.parse(body.ocr);
    } catch (err) {
        if (err instanceof ocrInput.OcrInputError) return res.status(400).json({error: err.code});
        throw err;
    }

    const read = idcard.read(profile, lines);
    const result = profile.check(read);
    if (!result) return res.status(422).json({error: 'id_unreadable', problems: ['id_number_not_found']});

    try {
        const publicId = 'ic_' + crypto.randomBytes(24).toString('base64url');
        const imageFile = await scanHelper.saveImage(storageDir(), publicId, image);
        const scan = await db.id_card_scan.create({
            public_id: publicId,
            client_id: req.client.id,
            reference,
            country: profile.code,
            card_type: result.document.card_type,
            status: result.status,
            failure_reason: result.failure_reason,
            document: result.document,
            checks: result.checks,
            review_reasons: result.review_reasons,
            extracted_by: read.extracted_by,
            confidence: read.confidence,
            ocr: {lines: lines.map(({text, box}) => ({text, box}))},
            image_file: imageFile,
            device: scanHelper.deviceInfo(body.device),
        });
        return res.status(201).json(scan.toPublic());
    } catch (err) {
        console.error('ID card scan failed:', err.message);
        return res.status(500).json({error: 'scan_failed'});
    }
};

const findOwn = (req) => db.id_card_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});

exports.Show = async (req, res) => {
    try {
        const scan = await findOwn(req);
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        return res.json(scan.toPublic());
    } catch (err) {
        console.error('ID card scan lookup failed:', err.message);
        return res.status(500).json({error: 'scan_lookup_failed'});
    }
};

function sendImage(res, scan) {
    if (!scan || !scan.image_file || !SCAN_ID.test(scan.public_id)) return res.status(404).json({error: 'image_not_available'});
    res.set('Cache-Control', 'private, no-store');
    return res.type('jpeg').sendFile(path.join(storageDir(), path.basename(scan.image_file)), (err) => {
        if (err && !res.headersSent) res.status(404).json({error: 'image_not_available'});
    });
}

/** The picture of the card the app took. */
exports.Image = async (req, res) => {
    try {
        return sendImage(res, await findOwn(req));
    } catch (err) {
        console.error('ID card image failed:', err.message);
        return res.status(500).json({error: 'image_failed'});
    }
};

/**
 * Compares the face on the card with the face from a liveness check this client ran and the person
 * passed. Each comparison replaces the last. A card with no face on it (the old metal card has none)
 * is recorded as `no_face_on_card`, which a verification session treats as a review, and isn't charged.
 */
exports.FaceMatch = async (req, res) => {
    const livenessId = req.body && typeof req.body.liveness_session_id === 'string' ? req.body.liveness_session_id : '';
    if (!LIVENESS_ID.test(livenessId)) return res.status(400).json({error: 'liveness_session_id_required'});
    try {
        const scan = await findOwn(req);
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        const session = await db.liveness_session.findOne({where: {public_id: livenessId, client_id: req.client.id}});
        if (!session) return res.status(404).json({error: 'liveness_session_not_found'});
        if (session.currentStatus() !== 'passed') {
            return res.status(409).json({error: 'liveness_not_passed', liveness_status: session.currentStatus()});
        }
        if (!scan.image_file) return res.status(422).json({error: 'no_card_photo'});
        let card;
        try {
            card = await fs.promises.readFile(path.join(storageDir(), path.basename(scan.image_file)));
        } catch {
            return res.status(422).json({error: 'no_card_photo'});
        }
        const live = await faceMatchHelper.livenessPhoto(session);
        if (!live) return res.status(422).json({error: 'no_liveness_photo'});

        const base = {liveness_session_id: session.public_id, liveness_passed: true, checked_at: new Date().toISOString()};
        let result;
        try {
            result = await faceMatchHelper.compare(card, live);
        } catch (err) {
            if (!(err instanceof faceMatchHelper.FaceMatchError)) throw err;
            if (err.code === 'no_face_in_passport') {
                await scan.update({face_match: {...base, status: 'no_face_on_card', matched: false, identity_verified: false}});
                return res.status(422).json({error: 'no_face_on_card'});
            }
            return res.status(422).json({error: err.code});
        }

        await scan.update({
            face_match: {
                ...result,
                ...base,
                matched: result.status === 'match',
                // No chip to vouch for an ID card: the card read cleanly and the faces match.
                identity_verified: scan.status === 'passed' && result.status === 'match',
            },
        });
        return res.status(201).json(scan.toPublic());
    } catch (err) {
        console.error('ID card face match failed:', err.message);
        return res.status(500).json({error: 'face_match_failed'});
    }
};

// ----- Admin: looking at scans, labelling them, and the models trained on the labels -----

/** `?country=ZW&labelled=0|1&status=review&client_id=7&page=1&per_page=25`, newest first. */
exports.AdminList = async (req, res) => {
    const {where, page, perPage} = listQuery(req.query, {statuses: ['passed', 'review', 'failed']});
    if (req.query.country) {
        const p = idcard.profile(req.query.country);
        if (!p) return unsupported(res);
        where.country = p.code;
    }
    if (req.query.labelled === '1') where.labelled_at = {[Op.ne]: null};
    if (req.query.labelled === '0') where.labelled_at = null;
    try {
        const {rows, count} = await db.id_card_scan.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit: perPage,
            offset: (page - 1) * perPage,
            include: [{model: db.client, attributes: ['id', 'name']}],
        });
        return res.json({
            scans: rows.map((s) => ({...s.toPublic(), client: s.client, labelled: Boolean(s.labelled_at)})),
            page, per_page: perPage, total: count,
        });
    } catch (err) {
        console.error('ID card admin list failed:', err.message);
        return res.status(500).json({error: 'scan_list_failed'});
    }
};

const findAny = (req) => (SCAN_ID.test(req.params.scanId)
    ? db.id_card_scan.findOne({where: {public_id: req.params.scanId}, include: [{model: db.client, attributes: ['id', 'name']}]})
    : null);

exports.AdminShow = async (req, res) => {
    try {
        const scan = await findAny(req);
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        const p = idcard.profile(scan.country);
        return res.json({
            scan: {...scan.toAdmin(), client: scan.client},
            profile: p ? {code: p.code, name: p.name, card_types: p.cardTypes, fields: p.fields} : null,
        });
    } catch (err) {
        console.error('ID card admin lookup failed:', err.message);
        return res.status(500).json({error: 'scan_lookup_failed'});
    }
};

exports.AdminImage = async (req, res) => {
    try {
        return sendImage(res, await findAny(req));
    } catch (err) {
        console.error('ID card admin image failed:', err.message);
        return res.status(500).json({error: 'image_failed'});
    }
};

/**
 * What the card really says, from an admin looking at its picture: {card_type, fields: {id_number, …}}.
 * Labelled scans are what the country's model is trained on. Values are checked and normalised the same
 * way the reader does (dates to YYYY-MM-DD, names uppercased), so a label means the same as a read.
 */
exports.AdminLabel = async (req, res) => {
    const body = req.body || {};
    try {
        const scan = await findAny(req);
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        const p = idcard.profile(scan.country);
        if (!p) return unsupported(res);

        if (body.card_type !== undefined && body.card_type !== null && !p.cardTypes.includes(body.card_type)) {
            return res.status(400).json({error: 'invalid_card_type', card_types: p.cardTypes});
        }
        const given = body.fields;
        if (!given || typeof given !== 'object' || Array.isArray(given)) return res.status(400).json({error: 'fields_required'});
        const fields = {};
        for (const [field, value] of Object.entries(given)) {
            if (!p.fields.includes(field)) return res.status(400).json({error: 'unknown_field', field, fields: p.fields});
            if (value === null || value === undefined || String(value).trim() === '') continue;
            if (typeof value !== 'string' || value.length > 120) return res.status(400).json({error: `invalid_${field}`});
            const normalised = p.normalise(field, value);
            if (!normalised) return res.status(400).json({error: `invalid_${field}`});
            fields[field] = normalised;
        }
        if (!fields.id_number) return res.status(400).json({error: 'id_number_required'});

        await scan.update({
            label: {card_type: body.card_type || null, fields},
            labelled_by: req.admin ? req.admin.id : null,
            labelled_at: new Date(),
        });
        return res.json({scan: {...scan.toAdmin(), client: scan.client}});
    } catch (err) {
        console.error('ID card label failed:', err.message);
        return res.status(500).json({error: 'label_failed'});
    }
};

/** Each supported country: its fields, labelled scan count, and its model (version, accuracy against the rules). */
exports.AdminModels = async (req, res) => {
    try {
        const countries = [];
        for (const c of idcard.supported()) {
            const [scans, labelled] = await Promise.all([
                db.id_card_scan.count({where: {country: c.code}}),
                db.id_card_scan.count({where: {country: c.code, labelled_at: {[Op.ne]: null}}}),
            ]);
            countries.push({...c, scans, labelled, model: idModel.summary(c.code)});
        }
        return res.json({countries});
    } catch (err) {
        console.error('ID card models failed:', err.message);
        return res.status(500).json({error: 'models_failed'});
    }
};

/** Reads the model files again, e.g. after `npm run idmodel:train`. */
exports.AdminReloadModels = (req, res) => {
    idModel.reload();
    return exports.AdminModels(req, res);
};
