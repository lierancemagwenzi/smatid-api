/**
 * Verification sessions: what each type checks, and how the steps add up to an outcome.
 */
const crypto = require('crypto');
const db = require('../../models');

/** The session types a client can ask for, and the steps the Smatid Verify app runs for each, in order. */
const TYPES = {
    liveness: ['liveness'],
    passport: ['passport'],
    passport_chip: ['passport', 'chip'],
    full: ['passport', 'chip', 'liveness', 'face_match'],
};

// Steps the app may skip (with a reason) without the session failing: the phone may have no NFC, or
// the passport no chip. The outcome is then "review", not "verified".
const SKIPPABLE = ['chip'];

// No 0/O or 1/I: easy to read out and type. 32 characters, 8 of them: 40 bits.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    return code;
}

/** "abcd-efgh", "ABCD EFGH" → "ABCDEFGH". */
const normaliseCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** The app's link that opens this session. */
const appLink = (publicId) => `smatid-verify://verify?id=${encodeURIComponent(publicId)}`;

/** The scan and liveness check the app ran for this session, if any. */
async function linked(session) {
    const [scan, liveness] = await Promise.all([
        session.passport_scan_id ? db.passport_scan.findOne({where: {public_id: session.passport_scan_id, client_id: session.client_id}}) : null,
        session.liveness_session_id ? db.liveness_session.findOne({where: {public_id: session.liveness_session_id, client_id: session.client_id}}) : null,
    ]);
    return {scan, liveness};
}

/** passed, review, failed, skipped or not_done, for each of the type's steps. */
function stepStatuses(session, {scan, liveness}) {
    const skipped = session.skipped || {};
    const status = {};
    for (const step of TYPES[session.type] || []) {
        let s = 'not_done';
        if (step === 'passport' && scan) s = scan.status === 'passed' ? 'passed' : 'failed';
        if (step === 'chip' && scan && scan.chip) {
            s = scan.chip.status === 'verified' ? 'passed' : scan.chip.status === 'unverified' ? 'review' : 'failed';
        }
        if (step === 'liveness' && liveness) {
            const ls = liveness.currentStatus();
            s = ls === 'passed' ? 'passed' : ['failed', 'expired'].includes(ls) ? 'failed' : 'not_done';
        }
        if (step === 'face_match' && scan && scan.face_match) {
            s = {match: 'passed', review: 'review'}[scan.face_match.status] || 'failed';
        }
        if (s === 'not_done' && skipped[step] && SKIPPABLE.includes(step)) s = 'skipped';
        status[step] = s;
    }
    return status;
}

/** verified (every step passed), review (none failed, but one needs a person or was skipped), failed, or incomplete. */
function outcomeOf(steps) {
    const values = Object.values(steps);
    if (values.includes('failed')) return 'failed';
    if (values.includes('not_done')) return 'incomplete';
    if (values.includes('review') || values.includes('skipped')) return 'review';
    return 'verified';
}

/** What the client gets back: the session, each step, and the checks' own results. */
async function clientView(session, baseUrl) {
    const checks = await linked(session);
    const steps = stepStatuses(session, checks);
    const status = session.currentStatus();
    return {
        verification_id: session.public_id,
        code: showCode(session.code),
        type: session.type,
        reference: session.reference,
        status,
        outcome: status === 'completed' ? outcomeOf(steps) : null,
        steps,
        skipped: session.skipped || {},
        app_link: appLink(session.public_id),
        return_url: session.return_url,
        passport: checks.scan ? checks.scan.toPublic() : null,
        liveness: checks.liveness ? checks.liveness.toPublic(baseUrl) : null,
        opened_at: session.opened_at,
        completed_at: session.completed_at,
        expires_at: session.expires_at,
        created_at: session.createdAt,
    };
}

/** What the Smatid Verify app is told: who's asking and what to do. No personal results. */
async function appView(session) {
    const checks = await linked(session);
    return {
        verification_id: session.public_id,
        type: session.type,
        steps: TYPES[session.type],
        progress: stepStatuses(session, checks),
        client_name: session.client ? session.client.name : null,
        status: session.currentStatus(),
        passport_scan_id: session.passport_scan_id,
        liveness_session_id: session.liveness_session_id,
        expires_at: session.expires_at,
    };
}

/** The client's return link with the session's ID and status added, or null. */
function returnLink(session) {
    if (!session.return_url) return null;
    const url = new URL(session.return_url);
    url.searchParams.set('verification_id', session.public_id);
    url.searchParams.set('status', session.currentStatus());
    return url.toString();
}

module.exports = {TYPES, SKIPPABLE, newCode, normaliseCode, showCode, appLink, linked, stepStatuses, outcomeOf, clientView, appView, returnLink};
