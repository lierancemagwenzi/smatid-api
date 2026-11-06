const crypto = require('crypto');
const webhookHelper = require('../helpers/webhookHelper');
const verificationHelper = require('../helpers/verification/verificationHelper');
const {limiter} = require('../helpers/rateLimitHelper');
const db = require('../models');

const SESSION_MINUTES = () => Number(process.env.VERIFICATION_SESSION_MINUTES || 30);
const VERIFICATION_ID = /^vs_[A-Za-z0-9_-]{32}$/;
const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// Same rules as liveness: an https website, http on this machine, or an app's own link.
const {validRedirect} = require('./LivenessController');

// Typing codes: 20 tries per IP per 15 minutes, so 8-character codes can't be guessed.
const codeTries = limiter({max: 20, windowMs: 15 * 60 * 1000});

// ----- Client API (Bearer kyc_ token) -----

/** Opens a session for the Smatid Verify app: {type, reference?, return_url?}. */
exports.Create = async (req, res) => {
    const body = req.body || {};
    if (!verificationHelper.TYPES[body.type]) {
        return res.status(400).json({error: 'invalid_type', types: Object.keys(verificationHelper.TYPES)});
    }
    const reference = body.reference === undefined || body.reference === null ? null : String(body.reference).trim();
    if (reference !== null && (!reference || reference.length > 255)) return res.status(400).json({error: 'invalid_reference'});
    if (body.return_url !== undefined && body.return_url !== null && !validRedirect(String(body.return_url))) {
        return res.status(400).json({error: 'invalid_return_url'});
    }
    try {
        // Codes are unique; on the rare clash, draw again.
        for (let tries = 0; tries < 5; tries++) {
            try {
                const session = await db.verification_session.create({
                    public_id: 'vs_' + crypto.randomBytes(24).toString('base64url'),
                    code: verificationHelper.newCode(),
                    client_id: req.client.id,
                    reference,
                    type: body.type,
                    return_url: body.return_url || null,
                    expires_at: new Date(Date.now() + SESSION_MINUTES() * 60 * 1000),
                });
                return res.status(201).json(await verificationHelper.clientView(session, baseUrl(req)));
            } catch (err) {
                if (err.name !== 'SequelizeUniqueConstraintError') throw err;
            }
        }
        throw new Error('could not draw a unique code');
    } catch (err) {
        console.error('Verification create failed:', err.message);
        return res.status(500).json({error: 'verification_create_failed'});
    }
};

/** The session and its results, for the client that opened it. */
exports.Show = async (req, res) => {
    try {
        const session = await db.verification_session.findOne({where: {public_id: String(req.params.verificationId), client_id: req.client.id}});
        if (!session) return res.status(404).json({error: 'verification_not_found'});
        return res.json(await verificationHelper.clientView(session, baseUrl(req)));
    } catch (err) {
        console.error('Verification lookup failed:', err.message);
        return res.status(500).json({error: 'verification_lookup_failed'});
    }
};

// ----- The Smatid Verify app (the session ID is its only key) -----

/** The person typed the code shown by the client app: answers with the session's ID. */
exports.Claim = async (req, res) => {
    const ip = req.ip;
    if (codeTries.blocked(ip)) return res.status(429).json({error: 'too_many_tries'});
    const code = verificationHelper.normaliseCode(req.body && req.body.code);
    if (code.length !== 8) return res.status(400).json({error: 'invalid_code'});
    try {
        const session = await db.verification_session.findOne({where: {code}, include: [{model: db.client, attributes: ['status']}]});
        if (!session || !session.isOpen() || !session.client || session.client.status !== 'active') {
            codeTries.hit(ip);
            return res.status(404).json({error: 'verification_not_found'});
        }
        return res.json({verification_id: session.public_id});
    } catch (err) {
        console.error('Verification claim failed:', err.message);
        return res.status(503).json({error: 'verification_unavailable'});
    }
};

/**
 * Loads the session from the link, and lets the app act as the client that opened it, so each check is
 * logged and charged to that client as usual. `step` is the step the call is for: it must be one of the
 * session type's steps, and the session must still be open.
 */
exports.requireSession = function (step) {
    return async function (req, res, next) {
        if (!VERIFICATION_ID.test(req.params.verificationId)) return res.status(404).json({error: 'verification_not_found'});
        try {
            const session = await db.verification_session.findOne({
                where: {public_id: req.params.verificationId},
                include: [{model: db.client}],
            });
            if (!session || !session.client || session.client.status !== 'active') {
                return res.status(404).json({error: 'verification_not_found'});
            }
            if (step) {
                if (!session.isOpen()) return res.status(409).json({error: 'verification_closed', status: session.currentStatus()});
                const steps = verificationHelper.TYPES[session.type] || [];
                if (!steps.includes(step)) return res.status(403).json({error: 'step_not_in_session', step, type: session.type});
            }
            req.verification = session;
            req.client = session.client;
            // The checks' own handlers read the body: the session decides these, not the app.
            if (req.body && typeof req.body === 'object') {
                delete req.body.webhook_url;
                req.body.reference = session.reference || undefined;
                if (req.body.reference === undefined) delete req.body.reference;
            }
            next();
        } catch (err) {
            console.error('Verification session lookup failed:', err.message);
            res.status(503).json({error: 'verification_unavailable'});
        }
    };
};

/** Only the scan, and the liveness check, this session made. */
exports.ownsScan = (req, res, next) =>
    req.verification.passport_scan_id === req.params.scanId ? next() : res.status(404).json({error: 'scan_not_found'});
exports.ownsLiveness = (req, res, next) =>
    req.verification.liveness_session_id === req.params.sessionId ? next() : res.status(404).json({error: 'session_not_found'});

/** The face match must use this session's own liveness check. */
exports.sameLiveness = (req, res, next) => {
    const id = req.body && req.body.liveness_session_id;
    if (!id || id !== req.verification.liveness_session_id) return res.status(409).json({error: 'liveness_not_in_session'});
    next();
};

/**
 * After a check is created (201), remembers its ID on the session, e.g. link('passport_scan_id', 'scan_id').
 * A later try replaces an earlier one.
 */
exports.link = (column, field) => (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode === 201 && body && body[field]) {
            req.verification.update({[column]: body[field]})
                .catch((err) => console.error(`Could not link ${field} to ${req.verification.public_id}:`, err.message));
        }
        return json(body);
    };
    next();
};

/** What the app needs to show: who's asking and which steps to run. Opening it marks it in progress. */
exports.AppShow = async (req, res) => {
    try {
        const session = req.verification;
        if (session.status === 'pending' && session.isOpen()) await session.update({status: 'in_progress', opened_at: new Date()});
        return res.json(await verificationHelper.appView(session));
    } catch (err) {
        console.error('Verification app view failed:', err.message);
        return res.status(503).json({error: 'verification_unavailable'});
    }
};

/**
 * The app has run the steps: closes the session and works out the outcome. `skipped` names steps the
 * app couldn't do and why, e.g. {"chip": "no_nfc"}; only the chip can be skipped.
 */
exports.Complete = async (req, res) => {
    const session = req.verification;
    if (!session.isOpen()) return res.status(409).json({error: 'verification_closed', status: session.currentStatus()});
    const skipped = {};
    const asked = (req.body && req.body.skipped) || {};
    for (const step of verificationHelper.SKIPPABLE) {
        if (typeof asked[step] === 'string' && asked[step]) skipped[step] = asked[step].slice(0, 64);
    }
    try {
        session.skipped = skipped;
        const checks = await verificationHelper.linked(session);
        const steps = verificationHelper.stepStatuses(session, checks);
        const outcome = verificationHelper.outcomeOf(steps);
        await session.update({status: 'completed', completed_at: new Date(), skipped, result: {outcome, steps}});
        notify(session).catch((err) => console.error('Verification webhook failed:', err.message));
        return res.json({status: 'completed', outcome, steps, return_url: verificationHelper.returnLink(session)});
    } catch (err) {
        console.error('Verification complete failed:', err.message);
        return res.status(503).json({error: 'verification_unavailable'});
    }
};

/** The person gave up in the app. */
exports.Cancel = async (req, res) => {
    const session = req.verification;
    if (!session.isOpen()) return res.status(409).json({error: 'verification_closed', status: session.currentStatus()});
    try {
        await session.update({status: 'cancelled', completed_at: new Date()});
        notify(session).catch((err) => console.error('Verification webhook failed:', err.message));
        return res.json({status: 'cancelled', return_url: verificationHelper.returnLink(session)});
    } catch (err) {
        console.error('Verification cancel failed:', err.message);
        return res.status(503).json({error: 'verification_unavailable'});
    }
};

/**
 * Tells the client's default webhook, if it has one: verification.completed. One try; the client can
 * always read the result with GET /api/kyc/verifications/:id.
 */
async function notify(session) {
    const client = session.client;
    if (!client || !client.webhook_url) return;
    const secret = await require('../helpers/liveness/deliveryHelper').secretFor(client);
    const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8011}`).replace(/\/$/, '');
    await webhookHelper.send(client.webhook_url, 'verification.completed', await verificationHelper.clientView(session, base), secret);
}
