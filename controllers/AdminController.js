const tokenHelper = require('../helpers/tokenHelper');
const passwordHelper = require('../helpers/passwordHelper');
const db = require('../models');

const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);

// Failed sign-ins per IP, so a password can't be guessed at speed. In memory: resets on restart.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function tooManyFailures(ip) {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
        failures.delete(ip);
        return false;
    }
    return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) failures.set(ip, {count: 1, since: Date.now()});
    else entry.count++;
}

exports.resetFailures = () => failures.clear();

exports.Login = async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!email || !password) return res.status(400).json({error: 'email_and_password_required'});
    if (tooManyFailures(req.ip)) return res.status(429).json({error: 'too_many_attempts'});

    try {
        const admin = await db.admin.findOne({where: {email}});
        // Check a password even without an account, so the reply time doesn't show which emails exist.
        const ok = await passwordHelper.verify(password, admin ? admin.password_hash : 'scrypt$AAAA$AAAA');
        if (!admin || !ok) {
            recordFailure(req.ip);
            return res.status(401).json({error: 'invalid_credentials'});
        }

        const token = tokenHelper.newSessionToken();
        const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
        await db.admin_session.create({admin_id: admin.id, token_hash: tokenHelper.sha256(token), expires_at: expiresAt});
        await admin.update({last_login_at: new Date()});
        // Expired sessions are only cleared out here; nothing else needs them gone.
        db.admin_session.destroy({where: {expires_at: {[db.Sequelize.Op.lt]: new Date()}}})
            .catch((err) => console.error('Could not clear old admin sessions:', err.message));

        return res.json({token, expires_at: expiresAt, admin: admin.toPublic()});
    } catch (err) {
        console.error('Admin login failed:', err.message);
        return res.status(503).json({error: 'auth_unavailable'});
    }
};

exports.Logout = async (req, res) => {
    try {
        if (req.adminSession) await req.adminSession.destroy();
        return res.json({signed_out: true});
    } catch (err) {
        console.error('Admin logout failed:', err.message);
        return res.status(500).json({error: 'logout_failed'});
    }
};

exports.Me = (req, res) => {
    // X-Admin-Key callers have no account.
    if (!req.admin) return res.json({admin: null, via: 'admin_key'});
    return res.json({admin: req.admin.toPublic(), expires_at: req.adminSession.expires_at, via: 'session'});
};
