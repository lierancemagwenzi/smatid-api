const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const faceHelper = require('../helpers/liveness/faceHelper');
const deliveryHelper = require('../helpers/liveness/deliveryHelper');
const webhookHelper = require('../helpers/webhookHelper');
const livenessHelper = require('../helpers/liveness/livenessHelper');
const db = require('../models');

const SESSION_MINUTES = Number(process.env.LIVENESS_SESSION_MINUTES || 30);
const MAX_ATTEMPTS = Number(process.env.LIVENESS_MAX_ATTEMPTS || 3);
// Time allowed from pressing Start to sending the frames, and the least a real person could need.
const MAX_ATTEMPT_SECONDS = 180;
const MIN_SECONDS_PER_STEP = 0.5;
const MAX_FRAME_BYTES = 600 * 1024;

const storageDir = () => process.env.LIVENESS_STORAGE_DIR || path.join(__dirname, '..', 'storage', 'liveness');
const SESSION_ID = /^lv_[A-Za-z0-9_-]{32}$/;
const FRAME_NAME = /^attempt-\d+-\d+-[a-z_]+\.jpg$/;

/** Where clients and people reach this service, for the hosted page's link. */
function baseUrl(req) {
    return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Schemes that could run code or read files instead of opening a website or an app.
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:', 'ws:', 'wss:', 'ftp:']);

/**
 * Where people can be sent back to: an https website, http on this machine for development, or a mobile
 * app's own link (e.g. acmebank://kyc/done), which opens the app when the check is over.
 */
function validRedirect(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:') return true;
        if (url.protocol === 'http:') return ['localhost', '127.0.0.1'].includes(url.hostname);
        return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEMES.has(url.protocol);
    } catch {
        return false;
    }
}

function redirectFor(session, status) {
    if (!session.redirect_url) return null;
    const url = new URL(session.redirect_url);
    url.searchParams.set('session_id', session.public_id);
    url.searchParams.set('status', status);
    return url.toString();
}

async function findForPage(req, res) {
    if (!SESSION_ID.test(req.params.sessionId)) {
        res.status(404).json({error: 'session_not_found'});
        return null;
    }
    const session = await db.liveness_session.findOne({
        where: {public_id: req.params.sessionId},
        include: [{model: db.client, attributes: ['name', 'status']}],
    });
    if (!session || !session.client || session.client.status !== 'active') {
        res.status(404).json({error: 'session_not_found'});
        return null;
    }
    return session;
}

/** What the hosted page needs to know about a session. */
function pageView(session, req) {
    const status = session.currentStatus();
    const final = ['passed', 'failed', 'expired'].includes(status);
    return {
        status,
        client_name: session.client.name,
        test: Boolean(session.test),
        attempts_left: Math.max(0, MAX_ATTEMPTS - session.attempts),
        failure_reason: session.failure_reason || null,
        redirect_url: final ? redirectFor(session, status) : null,
        // For moving the check to a phone: the page shows it as a QR code and a link to copy.
        page_url: `${baseUrl(req)}/liveness/${session.public_id}`,
    };
}

// ----- Client API (Bearer kyc_ token) -----

exports.Create = async (req, res) => {
    const body = req.body || {};
    const reference = body.reference === undefined || body.reference === null ? null : String(body.reference).trim();
    if (reference !== null && (!reference || reference.length > 255)) return res.status(400).json({error: 'invalid_reference'});
    if (body.redirect_url !== undefined && body.redirect_url !== null && !validRedirect(String(body.redirect_url))) {
        return res.status(400).json({error: 'invalid_redirect_url'});
    }
    if (body.webhook_url !== undefined && body.webhook_url !== null) {
        const problem = webhookHelper.urlProblem(body.webhook_url);
        if (problem) return res.status(400).json({error: problem});
    }
    try {
        const session = await db.liveness_session.create({
            public_id: 'lv_' + crypto.randomBytes(24).toString('base64url'),
            client_id: req.client.id,
            reference,
            redirect_url: body.redirect_url || null,
            // The session's own webhook, or else the client's default. Kept on the session, so changing the
            // default later doesn't redirect results already on their way.
            webhook_url: body.webhook_url || req.client.webhook_url || null,
            expires_at: new Date(Date.now() + SESSION_MINUTES * 60 * 1000),
        });
        return res.status(201).json(session.toPublic(baseUrl(req)));
    } catch (err) {
        console.error('Liveness session create failed:', err.message);
        return res.status(500).json({error: 'session_create_failed'});
    }
};

exports.Show = async (req, res) => {
    try {
        // Only the client that made a session can see it.
        const session = await db.liveness_session.findOne({where: {public_id: String(req.params.sessionId), client_id: req.client.id}});
        if (!session) return res.status(404).json({error: 'session_not_found'});
        return res.json(session.toPublic(baseUrl(req)));
    } catch (err) {
        console.error('Liveness session lookup failed:', err.message);
        return res.status(500).json({error: 'session_lookup_failed'});
    }
};

// ----- Portal test sessions (Developers page). Free, so there's a daily limit per client. -----

const TEST_OUTCOMES = ['passed', 'failed'];
const testDailyLimit = () => Number(process.env.LIVENESS_TEST_DAILY_LIMIT || 10);

/**
 * Starts a test session for the signed-in user's company. Without `outcome` it waits for someone to take
 * the check on the hosted page; with outcome "passed" or "failed" it finishes at once, with no camera, and
 * its webhook goes out like a real one.
 */
exports.PortalTestCreate = async (req, res) => {
    const outcome = req.body && req.body.outcome;
    if (outcome !== undefined && outcome !== null && !TEST_OUTCOMES.includes(outcome)) return res.status(400).json({error: 'invalid_outcome'});
    const client = req.portalClient;
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const used = await db.liveness_session.count({where: {client_id: client.id, test: true, created_at: {[db.Sequelize.Op.gte]: since}}});
        if (used >= testDailyLimit()) return res.status(429).json({error: 'test_limit_reached', limit: testDailyLimit()});

        const now = new Date();
        const fields = {
            public_id: 'lv_' + crypto.randomBytes(24).toString('base64url'),
            client_id: client.id,
            reference: 'portal-test',
            webhook_url: client.webhook_url || null,
            expires_at: new Date(now.getTime() + SESSION_MINUTES * 60 * 1000),
            test: true,
        };
        if (outcome) {
            const passed = outcome === 'passed';
            Object.assign(fields, {
                status: outcome, attempts: 1, started_at: now, completed_at: now,
                result: {passed, failure_reason: passed ? null : 'simulated_failure', scores: null, steps: null, simulated: true},
                failure_reason: passed ? null : 'simulated_failure',
            });
        }
        const session = await db.liveness_session.create(fields);
        if (outcome) await deliveryHelper.finished(session);
        return res.status(201).json({session: session.toPublic(baseUrl(req)), tests_left_today: Math.max(0, testDailyLimit() - used - 1)});
    } catch (err) {
        console.error('Liveness test create failed:', err.message);
        return res.status(500).json({error: 'session_create_failed'});
    }
};

/** One of the company's test sessions, for the Developers page to follow. */
exports.PortalTestShow = async (req, res) => {
    try {
        const session = await db.liveness_session.findOne({where: {public_id: String(req.params.sessionId), client_id: req.portalClient.id, test: true}});
        if (!session) return res.status(404).json({error: 'session_not_found'});
        return res.json({session: session.toPublic(baseUrl(req))});
    } catch (err) {
        console.error('Liveness test lookup failed:', err.message);
        return res.status(500).json({error: 'session_lookup_failed'});
    }
};

// ----- Hosted page API (the session ID in the link is the only key) -----

exports.Page = async (req, res) => {
    res.set({
        'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob: mediastream:",
            "connect-src 'self' blob: data:",
            "worker-src 'self' blob:",
            "frame-ancestors 'none'",
        ].join('; '),
        'Permissions-Policy': 'camera=(self), microphone=()',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });

    // The page only renders for a real session, from a client that still has access, while liveness is on.
    // The session ID in the link is the token: random, only ever given to the client that created it.
    try {
        const session = SESSION_ID.test(req.params.sessionId) && await db.liveness_session.findOne({
            where: {public_id: req.params.sessionId},
            include: [{model: db.client, attributes: ['name', 'status']}],
        });
        if (!session || !session.client || session.client.status !== 'active') {
            return sendErrorPage(res, 404, 'This link isn’t valid', 'Check that you opened the whole link, or ask the company that sent it for a new one.');
        }
        const livenessModule = await db.kyc_module.findOne({where: {key: 'liveness-check'}});
        if (!livenessModule || livenessModule.status !== 'enabled') {
            return sendErrorPage(res, 403, 'This check isn’t available', 'Please try again later.');
        }
    } catch (err) {
        console.error('Liveness page lookup failed:', err.message);
        return sendErrorPage(res, 503, 'Something went wrong', 'Please try again in a moment.');
    }
    // Finished and expired sessions still get the page: it shows the outcome and sends the person back.
    res.sendFile(path.join(__dirname, '..', 'public', 'liveness', 'index.html'));
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** A plain page for links that can't be used: no camera, no scripts. */
function sendErrorPage(res, status, title, text) {
    res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · Smatid</title>
<link rel="stylesheet" href="/liveness/assets/liveness.css"></head>
<body><main class="app"><header class="brand"><span>Smatid <b>verify</b></span></header>
<section class="screen center-screen"><div class="result-icon bad" aria-hidden="true"></div>
<h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(text)}</p></section></main></body></html>`);
}

exports.PageInfo = async (req, res) => {
    try {
        const session = await findForPage(req, res);
        if (session) res.json(pageView(session, req));
    } catch (err) {
        console.error('Liveness page lookup failed:', err.message);
        res.status(503).json({error: 'liveness_unavailable'});
    }
};

exports.Start = async (req, res) => {
    try {
        const session = await findForPage(req, res);
        if (!session) return;
        const status = session.currentStatus();
        if (!['pending', 'started'].includes(status)) return res.status(409).json({error: 'session_closed', ...pageView(session, req)});
        if (session.attempts >= MAX_ATTEMPTS) return res.status(409).json({error: 'no_attempts_left', ...pageView(session, req)});

        const steps = livenessHelper.newSteps();
        await session.update({status: 'started', steps, started_at: new Date(), attempts: session.attempts + 1});
        // Load the models now, while the person gets ready, so checking the frames isn't slowed down.
        faceHelper.load().catch((err) => console.error('Face models failed to load:', err.message));
        return res.json({steps, thresholds: livenessHelper.thresholds(), attempts_left: MAX_ATTEMPTS - session.attempts});
    } catch (err) {
        console.error('Liveness start failed:', err.message);
        return res.status(503).json({error: 'liveness_unavailable'});
    }
};

exports.Submit = async (req, res) => {
    let session;
    try {
        session = await findForPage(req, res);
        if (!session) return;
        if (session.currentStatus() !== 'started') return res.status(409).json({error: 'not_started', ...pageView(session, req)});

        const steps = session.steps || [];
        const elapsed = (Date.now() - new Date(session.started_at).getTime()) / 1000;
        const frames = Array.isArray(req.body && req.body.frames) ? req.body.frames : [];

        let failure = null;
        if (elapsed > MAX_ATTEMPT_SECONDS) failure = 'too_slow';
        else if (elapsed < steps.length * MIN_SECONDS_PER_STEP) failure = 'too_fast';
        else if (frames.length !== steps.length) failure = 'wrong_frame_count';

        const buffers = [];
        if (!failure) {
            for (const frame of frames) {
                const base64 = String(frame || '').replace(/^data:image\/jpeg;base64,/, '');
                const buffer = Buffer.from(base64, 'base64');
                if (!buffer.length || buffer.length > MAX_FRAME_BYTES) {
                    failure = 'invalid_frame';
                    break;
                }
                buffers.push(buffer);
            }
        }

        let verdict;
        if (failure) {
            verdict = {passed: false, failure_reason: failure, scores: null, steps: null};
        } else {
            try {
                const measurements = [];
                for (const buffer of buffers) measurements.push(await faceHelper.measure(buffer));
                const hashes = buffers.map((b) => crypto.createHash('sha256').update(b).digest('hex'));
                verdict = await livenessHelper.verify(steps, measurements, hashes, faceHelper.similarity);
            } catch (err) {
                if (err.code !== 'invalid_frame') throw err;
                verdict = {passed: false, failure_reason: 'invalid_frame', scores: null, steps: null};
            }
            await saveFrames(session, steps, buffers);
        }

        const attemptsLeft = MAX_ATTEMPTS - session.attempts;
        // A failed attempt with tries left goes back to pending, so the person can start again.
        const status = verdict.passed ? 'passed' : attemptsLeft > 0 ? 'pending' : 'failed';
        const final = status !== 'pending';
        await session.update({
            status,
            result: {...verdict, elapsed_seconds: Math.round(elapsed * 10) / 10},
            failure_reason: verdict.passed ? null : verdict.failure_reason,
            completed_at: final ? new Date() : null,
        });
        if (final) deliveryHelper.finished(session).catch((err) => console.error('Webhook queue failed:', err.message));
        return res.json({...pageView(session, req), passed: verdict.passed});
    } catch (err) {
        console.error('Liveness submit failed:', err.message);
        return res.status(503).json({error: 'liveness_unavailable'});
    }
};

/** Keeps the frames for review: storage/liveness/<session>/attempt-<n>-<i>-<step>.jpg. */
async function saveFrames(session, steps, buffers) {
    try {
        const dir = path.join(storageDir(), session.public_id);
        await fs.promises.mkdir(dir, {recursive: true});
        await Promise.all(buffers.map((b, i) =>
            fs.promises.writeFile(path.join(dir, `attempt-${session.attempts}-${i}-${steps[i]}.jpg`), b)));
    } catch (err) {
        console.error(`Could not save liveness frames for ${session.public_id}:`, err.message);
    }
}

/** The straight-on picture from the latest try, e.g. to compare with an ID document. */
exports.Image = async (req, res) => {
    try {
        const session = await db.liveness_session.findOne({where: {public_id: String(req.params.sessionId), client_id: req.client.id}});
        if (!session || !SESSION_ID.test(session.public_id)) return res.status(404).json({error: 'session_not_found'});
        const name = `attempt-${session.attempts}-0-center.jpg`;
        const file = path.join(storageDir(), session.public_id, name);
        if (!session.attempts || !session.result || !session.result.steps || !fs.existsSync(file)) {
            return res.status(404).json({error: 'image_not_available'});
        }
        res.set('Cache-Control', 'private, no-store');
        return res.type('jpeg').sendFile(file);
    } catch (err) {
        console.error('Liveness image failed:', err.message);
        return res.status(500).json({error: 'image_failed'});
    }
};

/** The page's link as a QR code, so someone on a computer can carry on with their phone. */
exports.QrCode = async (req, res) => {
    try {
        const session = await findForPage(req, res);
        if (!session) return;
        const svg = await QRCode.toString(pageView(session, req).page_url,
            {type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: {dark: '#0f172a', light: '#ffffff'}});
        res.set('Cache-Control', 'private, max-age=600');
        return res.type('image/svg+xml').send(svg);
    } catch (err) {
        console.error('Liveness QR code failed:', err.message);
        return res.status(500).json({error: 'qr_failed'});
    }
};

// ----- Webhook secret (Bearer kyc_ token). Never logged: the reply holds the secret. -----

exports.WebhookSecret = async (req, res) => {
    try {
        return res.json({webhook_secret: await deliveryHelper.secretFor(req.client)});
    } catch (err) {
        console.error('Webhook secret failed:', err.message);
        return res.status(500).json({error: 'webhook_secret_failed'});
    }
};

// ----- Default webhook URL (Bearer kyc_ token) -----

exports.Webhook = (req, res) => res.json({webhook_url: req.client.webhook_url || null});

/** Sets the default webhook, or clears it with null or "". */
exports.SetWebhook = async (req, res) => {
    const value = req.body ? req.body.webhook_url : undefined;
    if (value === undefined) return res.status(400).json({error: 'webhook_url_required'});
    const url = value === null ? '' : String(value).trim();
    if (url) {
        const problem = webhookHelper.urlProblem(url);
        if (problem) return res.status(400).json({error: problem});
    }
    try {
        await req.client.update({webhook_url: url || null});
        // Make sure there's a secret to sign with as soon as a webhook is set.
        if (url) await deliveryHelper.secretFor(req.client);
        return res.json({webhook_url: req.client.webhook_url || null});
    } catch (err) {
        console.error('Webhook update failed:', err.message);
        return res.status(500).json({error: 'webhook_update_failed'});
    }
};

exports.RotateWebhookSecret = async (req, res) => {
    try {
        await req.client.update({webhook_secret: webhookHelper.newSecret()});
        return res.json({webhook_secret: req.client.webhook_secret});
    } catch (err) {
        console.error('Webhook secret rotate failed:', err.message);
        return res.status(500).json({error: 'webhook_secret_failed'});
    }
};

// ----- Admin -----

exports.AdminShow = async (req, res) => {
    try {
        if (!SESSION_ID.test(req.params.sessionId)) return res.status(404).json({error: 'session_not_found'});
        const session = await db.liveness_session.findOne({
            where: {public_id: req.params.sessionId},
            include: [{model: db.client, attributes: ['id', 'name']}],
        });
        if (!session) return res.status(404).json({error: 'session_not_found'});
        let frames = [];
        try {
            frames = (await fs.promises.readdir(path.join(storageDir(), session.public_id))).filter((f) => FRAME_NAME.test(f)).sort();
        } catch {
            // No frames saved for this session.
        }
        return res.json({
            session: {...session.toPublic(baseUrl(req)), client: session.client, result: session.result},
            frames,
        });
    } catch (err) {
        console.error('Liveness admin lookup failed:', err.message);
        return res.status(500).json({error: 'session_lookup_failed'});
    }
};

exports.AdminFrame = (req, res) => {
    if (!SESSION_ID.test(req.params.sessionId) || !FRAME_NAME.test(req.params.frame)) {
        return res.status(404).json({error: 'frame_not_found'});
    }
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(storageDir(), req.params.sessionId, req.params.frame), (err) => {
        if (err && !res.headersSent) res.status(404).json({error: 'frame_not_found'});
    });
};
