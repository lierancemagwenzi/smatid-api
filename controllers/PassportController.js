const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mrzHelper = require('../helpers/passport/mrzHelper');
const chipHelper = require('../helpers/passport/chipHelper');
const photoHelper = require('../helpers/passport/photoHelper');
const faceMatchHelper = require('../helpers/passport/faceMatchHelper');
const db = require('../models');

const MAX_IMAGE_BYTES = Number(process.env.PASSPORT_MAX_IMAGE_KB || 2048) * 1024;
const SCAN_ID = /^ps_[A-Za-z0-9_-]{32}$/;
const storageDir = () => process.env.PASSPORT_STORAGE_DIR || path.join(__dirname, '..', 'storage', 'passport');

/** The JPEG from the app: base64, with or without a data: prefix. Null if it isn't a usable JPEG. */
function decodeImage(value) {
    if (typeof value !== 'string' || !value) return null;
    const buffer = Buffer.from(value.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    // JPEG files start FF D8 FF.
    if (buffer.length < 1024 || buffer.length > MAX_IMAGE_BYTES || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
    return buffer;
}

/** Only the few things the SDK reports about itself; anything else is dropped. */
function deviceInfo(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const key of ['sdk', 'sdk_version', 'platform', 'os_version', 'scan_ms', 'frames']) {
        const v = value[key];
        if (typeof v === 'string') out[key] = v.slice(0, 64);
        else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * A scanned passport photo page: the MRZ lines the app read and the picture it took. The server
 * decides what the MRZ says. A read that doesn't hold together answers 422 (not charged), so the app can
 * scan again; a good read of a passport that has expired is a scan that "failed".
 */
exports.Scan = async (req, res) => {
    const body = req.body || {};
    const reference = body.reference === undefined || body.reference === null ? null : String(body.reference).trim();
    if (reference !== null && (!reference || reference.length > 255)) return res.status(400).json({error: 'invalid_reference'});
    if (body.mrz === undefined || body.mrz === null || (typeof body.mrz !== 'string' && !Array.isArray(body.mrz))) {
        return res.status(400).json({error: 'mrz_required'});
    }
    const image = decodeImage(body.image);
    if (!image) return res.status(400).json({error: 'invalid_image'});

    const read = mrzHelper.parse(body.mrz);
    if (!read.valid) {
        return res.status(422).json({error: 'mrz_unreadable', problems: read.problems, mrz: read.lines});
    }

    const expired = read.fields.expired === true;
    try {
        const publicId = 'ps_' + crypto.randomBytes(24).toString('base64url');
        const imageFile = await saveImage(publicId, image);
        const scan = await db.passport_scan.create({
            public_id: publicId,
            client_id: req.client.id,
            reference,
            status: expired ? 'failed' : 'passed',
            failure_reason: expired ? 'document_expired' : null,
            mrz: read.lines,
            document: read.fields,
            checks: read.checks,
            image_file: imageFile,
            device: deviceInfo(body.device),
        });
        return res.status(201).json(scan.toPublic());
    } catch (err) {
        console.error('Passport scan failed:', err.message);
        return res.status(500).json({error: 'scan_failed'});
    }
};

/** storage/passport/<scan>.jpg. Returns the file name, or null if it couldn't be written. */
async function saveImage(publicId, buffer) {
    try {
        await fs.promises.mkdir(storageDir(), {recursive: true});
        const name = `${publicId}.jpg`;
        await fs.promises.writeFile(path.join(storageDir(), name), buffer);
        return name;
    } catch (err) {
        console.error(`Could not save passport image for ${publicId}:`, err.message);
        return null;
    }
}

exports.Show = async (req, res) => {
    try {
        // Only the client that made a scan can see it.
        const scan = await db.passport_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        return res.json(scan.toPublic());
    } catch (err) {
        console.error('Passport scan lookup failed:', err.message);
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

/** The photo page picture the app took. */
exports.Image = async (req, res) => {
    try {
        const scan = await db.passport_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});
        return sendImage(res, scan);
    } catch (err) {
        console.error('Passport image failed:', err.message);
        return res.status(500).json({error: 'image_failed'});
    }
};

// ----- The chip (NFC) -----

// The files a phone may send from a chip, and the most each can be. DG2 holds the face picture.
const CHIP_FILES = {com: 1024, sod: 64 * 1024, dg1: 1024, dg2: 256 * 1024, dg14: 16 * 1024, dg15: 16 * 1024};

/** The chip files from the request, base64 to Buffers. Returns {files} or {error}. */
function chipFiles(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {error: 'files_required'};
    const files = {};
    for (const [name, max] of Object.entries(CHIP_FILES)) {
        const v = value[name];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || !/^[A-Za-z0-9+/=_-]+$/.test(v)) return {error: `invalid_${name}`};
        const buffer = Buffer.from(v, 'base64');
        if (!buffer.length || buffer.length > max) return {error: `invalid_${name}`};
        files[name] = buffer;
    }
    if (!files.sod) return {error: 'sod_required'};
    if (!files.dg1) return {error: 'dg1_required'};
    return {files};
}

/**
 * What the app read from the passport's chip, for a scan of the same passport. The server checks
 * the data groups against EF.SOD, the signature, and the signer against our CSCA certificates, then
 * compares the chip's details with the photo page scan. Each read replaces the last.
 */
exports.Chip = async (req, res) => {
    const body = req.body || {};
    const {files, error} = chipFiles(body.files);
    if (error) return res.status(400).json({error});
    const access = ['pace', 'bac'].includes(body.access) ? body.access : null;
    try {
        const scan = await db.passport_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});
        if (!scan) return res.status(404).json({error: 'scan_not_found'});

        let result;
        try {
            result = chipHelper.verify(files, {scanFields: scan.document});
        } catch (err) {
            if (err instanceof chipHelper.ChipDataError) return res.status(422).json({error: 'chip_data_invalid', detail: err.message});
            throw err;
        }

        const {_photo: photo, ...chip} = result;
        const readAt = new Date();
        // JPEG 2000 pictures are turned into JPEG, so apps and browsers can show them.
        const picture = photo ? await photoHelper.toJpeg(photo) : null;
        if (photo) {
            chip.photo = picture.error
                ? {format: photo.format, bytes: photo.data.length, conversion_error: picture.error}
                : {format: 'jpeg', original_format: photo.format, width: picture.width, height: picture.height, bytes: picture.jpeg.length};
        }
        const photoFile = await saveChipFiles(scan.public_id, files, photo, picture);
        await scan.update({
            chip: {...chip, access, read_at: readAt.toISOString()},
            chip_photo_file: photoFile,
            chip_read_at: readAt,
        });
        return res.status(201).json(scan.toPublic());
    } catch (err) {
        console.error('Passport chip check failed:', err.message);
        return res.status(500).json({error: 'chip_check_failed'});
    }
};

/**
 * Keeps what the chip gave, so a check can be run again later (say, after adding a country's CSCA):
 * storage/passport/<scan>/chip-<file>.bin, and the face picture as chip-photo.jpg. A JPEG 2000 original
 * is kept too, as chip-photo-original.jp2; if it couldn't be converted, it's the one served.
 */
async function saveChipFiles(publicId, files, photo, picture) {
    try {
        const dir = path.join(storageDir(), publicId);
        await fs.promises.mkdir(dir, {recursive: true});
        await Promise.all(Object.entries(files).map(([name, b]) => fs.promises.writeFile(path.join(dir, `chip-${name}.bin`), b)));
        if (!photo) return null;
        if (photo.format !== 'jpeg') await fs.promises.writeFile(path.join(dir, 'chip-photo-original.jp2'), photo.data);
        if (picture && picture.jpeg) {
            await fs.promises.writeFile(path.join(dir, 'chip-photo.jpg'), picture.jpeg);
            return `${publicId}/chip-photo.jpg`;
        }
        return `${publicId}/chip-photo-original.jp2`;
    } catch (err) {
        console.error(`Could not save chip files for ${publicId}:`, err.message);
        return null;
    }
}

function sendChipPhoto(res, scan) {
    if (!scan || !scan.chip_photo_file || !SCAN_ID.test(scan.public_id)) return res.status(404).json({error: 'photo_not_available'});
    const name = path.basename(scan.chip_photo_file);
    res.set('Cache-Control', 'private, no-store');
    // Normally a JPEG; only a JPEG 2000 that couldn't be converted is sent as it came.
    res.type(name.endsWith('.jpg') ? 'jpeg' : 'image/jp2');
    return res.sendFile(path.join(storageDir(), scan.public_id, name), (err) => {
        if (err && !res.headersSent) res.status(404).json({error: 'photo_not_available'});
    });
}

/** The face picture stored on the chip. */
exports.ChipPhoto = async (req, res) => {
    try {
        const scan = await db.passport_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});
        return sendChipPhoto(res, scan);
    } catch (err) {
        console.error('Passport chip photo failed:', err.message);
        return res.status(500).json({error: 'photo_failed'});
    }
};

// ----- Face match (passport photo against a liveness check) -----

const livenessDir = () => process.env.LIVENESS_STORAGE_DIR || path.join(__dirname, '..', 'storage', 'liveness');
const LIVENESS_ID = /^lv_[A-Za-z0-9_-]{32}$/;

/** The passport picture to compare: the chip's (signed by the issuing country) if it was read, else the photo page. */
async function passportPicture(scan) {
    if (scan.chip_photo_file && scan.chip_photo_file.endsWith('.jpg')) {
        try {
            return {source: 'chip', jpeg: await fs.promises.readFile(path.join(storageDir(), scan.public_id, 'chip-photo.jpg'))};
        } catch {
            // Fall back to the photo page.
        }
    }
    if (scan.image_file) {
        try {
            return {source: 'photo_page', jpeg: await fs.promises.readFile(path.join(storageDir(), path.basename(scan.image_file)))};
        } catch {
            // Nothing to compare.
        }
    }
    return null;
}

/**
 * Compares the passport's photo with the face from a liveness check this client ran and the person
 * passed. Each comparison replaces the last. `identity_verified` is the whole chain: a verified chip, a
 * passed liveness check, and a face match.
 */
exports.FaceMatch = async (req, res) => {
    const livenessId = req.body && typeof req.body.liveness_session_id === 'string' ? req.body.liveness_session_id : '';
    if (!LIVENESS_ID.test(livenessId)) return res.status(400).json({error: 'liveness_session_id_required'});
    try {
        const scan = await db.passport_scan.findOne({where: {public_id: String(req.params.scanId), client_id: req.client.id}});
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        const session = await db.liveness_session.findOne({where: {public_id: livenessId, client_id: req.client.id}});
        if (!session) return res.status(404).json({error: 'liveness_session_not_found'});
        if (session.currentStatus() !== 'passed') {
            return res.status(409).json({error: 'liveness_not_passed', liveness_status: session.currentStatus()});
        }

        const picture = await passportPicture(scan);
        if (!picture) return res.status(422).json({error: 'no_passport_photo'});
        let live;
        try {
            live = await fs.promises.readFile(path.join(livenessDir(), session.public_id, `attempt-${session.attempts}-0-center.jpg`));
        } catch {
            return res.status(422).json({error: 'no_liveness_photo'});
        }

        let result;
        try {
            result = await faceMatchHelper.compare(picture.jpeg, live);
        } catch (err) {
            if (err instanceof faceMatchHelper.FaceMatchError) return res.status(422).json({error: err.code});
            throw err;
        }

        const chipVerified = Boolean(scan.chip && scan.chip.status === 'verified');
        await scan.update({
            face_match: {
                ...result,
                matched: result.status === 'match',
                passport_photo: picture.source,
                chip_verified: chipVerified,
                liveness_session_id: session.public_id,
                liveness_passed: true,
                identity_verified: chipVerified && result.status === 'match',
                checked_at: new Date().toISOString(),
            },
        });
        return res.status(201).json(scan.toPublic());
    } catch (err) {
        console.error('Face match failed:', err.message);
        return res.status(500).json({error: 'face_match_failed'});
    }
};

// ----- Admin -----

/** Which CSCA certificates the server holds, by country. `?reload=1` reads config/csca/ again. */
exports.AdminCsca = (req, res) => {
    try {
        const store = chipHelper.loadStore({reload: req.method === 'POST'});
        const countries = {};
        for (const cert of store.certs) {
            const m = cert.subject.match(/(?:^|\n)C=([A-Za-z]+)/);
            const c = m ? m[1].toUpperCase() : '?';
            countries[c] = (countries[c] || 0) + 1;
        }
        return res.json({certificates: store.certs.length, countries, files: store.files, loaded_at: store.loaded_at});
    } catch (err) {
        console.error('CSCA store failed:', err.message);
        return res.status(500).json({error: 'csca_store_failed'});
    }
};

exports.AdminChipPhoto = async (req, res) => {
    try {
        if (!SCAN_ID.test(req.params.scanId)) return res.status(404).json({error: 'photo_not_available'});
        return sendChipPhoto(res, await db.passport_scan.findOne({where: {public_id: req.params.scanId}}));
    } catch (err) {
        console.error('Passport admin chip photo failed:', err.message);
        return res.status(500).json({error: 'photo_failed'});
    }
};

exports.AdminShow = async (req, res) => {
    try {
        if (!SCAN_ID.test(req.params.scanId)) return res.status(404).json({error: 'scan_not_found'});
        const scan = await db.passport_scan.findOne({
            where: {public_id: req.params.scanId},
            include: [{model: db.client, attributes: ['id', 'name']}],
        });
        if (!scan) return res.status(404).json({error: 'scan_not_found'});
        return res.json({scan: {...scan.toPublic(), client: scan.client, device: scan.device}});
    } catch (err) {
        console.error('Passport admin lookup failed:', err.message);
        return res.status(500).json({error: 'scan_lookup_failed'});
    }
};

exports.AdminImage = async (req, res) => {
    try {
        if (!SCAN_ID.test(req.params.scanId)) return res.status(404).json({error: 'image_not_available'});
        return sendImage(res, await db.passport_scan.findOne({where: {public_id: req.params.scanId}}));
    } catch (err) {
        console.error('Passport admin image failed:', err.message);
        return res.status(500).json({error: 'image_failed'});
    }
};
