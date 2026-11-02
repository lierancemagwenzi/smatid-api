const passwordHelper = require('../helpers/passwordHelper');
const portalAuth = require('../helpers/portalAuthHelper');
const billing = require('../helpers/billing/billingHelper');
const mailHelper = require('../helpers/mailHelper');
const {limiter} = require('../helpers/rateLimitHelper');
const db = require('../models');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per IP: wrong passwords, and requests that send email (so nobody can flood an inbox from here).
const loginFailures = limiter({max: 10, windowMs: 15 * 60 * 1000});
const emailSends = limiter({max: 8, windowMs: 60 * 60 * 1000});

exports.resetLimits = () => {
    loginFailures.reset();
    emailSends.reset();
};

const clean = (v) => String(v === undefined || v === null ? '' : v).trim();
const emailOf = (v) => clean(v).toLowerCase();

function passwordProblem(password) {
    if (typeof password !== 'string' || password.length < passwordHelper.MIN_LENGTH) return 'password_too_short';
    if (password.length > 200) return 'password_too_long';
    return null;
}

/** What the portal shows about the signed-in user and their company. */
async function view(user, client) {
    return {
        user: user.toPublic(),
        client: {
            id: client.id,
            name: client.name,
            email: client.email,
            status: client.status,
            ...client.balance(),
            has_api_token: Boolean(client.token_hash),
            token_prefix: client.token_prefix,
            webhook_url: client.webhook_url || null,
            created_at: client.createdAt,
        },
    };
}

async function signedIn(user) {
    const client = await db.client.findByPk(user.client_id);
    return {...(await portalAuth.startSession(user)), ...(await view(user, client))};
}

exports.view = view;

/** Creates a company and its owner. The trial starts when the email is confirmed. */
exports.Register = async (req, res) => {
    const body = req.body || {};
    const company = clean(body.company_name);
    const name = clean(body.name);
    const email = emailOf(body.email);
    if (!company || company.length > 255) return res.status(400).json({error: 'company_name_required'});
    if (!name || name.length > 255) return res.status(400).json({error: 'name_required'});
    if (!EMAIL_PATTERN.test(email) || email.length > 255) return res.status(400).json({error: 'valid_email_required'});
    const problem = passwordProblem(body.password);
    if (problem) return res.status(400).json({error: problem});
    if (emailSends.blocked(req.ip)) return res.status(429).json({error: 'too_many_attempts'});
    emailSends.hit(req.ip);

    // The same answer whether or not the email is taken, so this can't be used to find out who has an account.
    const reply = () => res.status(201).json({registered: true, email});
    try {
        const existing = await db.user.findOne({where: {email}});
        if (existing) {
            mailHelper.sendAlreadyRegistered(existing).catch(() => {});
            return reply();
        }
        const passwordHash = await passwordHelper.hash(body.password);
        const user = await db.sequelize.transaction(async (transaction) => {
            const client = await db.client.create({name: company, email, registered_via: 'self'}, {transaction});
            return db.user.create({client_id: client.id, name, email, password_hash: passwordHash, role: 'owner'}, {transaction});
        });
        const token = await portalAuth.issueLinkToken(user, 'verify_email');
        await mailHelper.sendVerifyEmail(user, token);
        return reply();
    } catch (err) {
        console.error('Registration failed:', err.message);
        return res.status(500).json({error: 'registration_failed'});
    }
};

/** Confirms the email from the link, starts the client's trial and signs the user in. */
exports.VerifyEmail = async (req, res) => {
    try {
        const used = await portalAuth.consumeLinkToken(clean(req.body && req.body.token), ['verify_email']);
        if (!used) return res.status(400).json({error: 'invalid_or_expired_link'});
        const {user} = used;
        if (!user.email_verified_at) await user.update({email_verified_at: new Date()});
        await billing.startTrial(user.client_id);
        return res.json(await signedIn(user));
    } catch (err) {
        console.error('Email verification failed:', err.message);
        return res.status(500).json({error: 'verification_failed'});
    }
};

exports.ResendVerification = async (req, res) => {
    const email = emailOf(req.body && req.body.email);
    if (emailSends.blocked(req.ip)) return res.status(429).json({error: 'too_many_attempts'});
    emailSends.hit(req.ip);
    try {
        const user = EMAIL_PATTERN.test(email) && await db.user.findOne({where: {email}});
        if (user && !user.email_verified_at && user.password_hash) {
            await mailHelper.sendVerifyEmail(user, await portalAuth.issueLinkToken(user, 'verify_email'));
        }
        return res.json({sent: true});
    } catch (err) {
        console.error('Resending verification failed:', err.message);
        return res.status(500).json({error: 'resend_failed'});
    }
};

exports.Login = async (req, res) => {
    const email = emailOf(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    if (!email || !password) return res.status(400).json({error: 'email_and_password_required'});
    if (loginFailures.blocked(req.ip)) return res.status(429).json({error: 'too_many_attempts'});
    try {
        const user = await db.user.findOne({where: {email}, include: [{model: db.client}]});
        // Check a password even with no such user, so the time taken doesn't show which emails exist.
        const ok = await passwordHelper.verify(password, user && user.password_hash ? user.password_hash : 'scrypt$AAAA$AAAA');
        if (!user || !ok || user.status !== 'active') {
            loginFailures.hit(req.ip);
            return res.status(401).json({error: 'invalid_credentials'});
        }
        if (!user.email_verified_at) return res.status(403).json({error: 'email_not_verified'});
        if (!user.client || user.client.status !== 'active') return res.status(403).json({error: 'account_suspended'});
        return res.json(await signedIn(user));
    } catch (err) {
        console.error('Portal login failed:', err.message);
        return res.status(503).json({error: 'auth_unavailable'});
    }
};

exports.Logout = async (req, res) => {
    try {
        await req.userSession.destroy();
        return res.json({signed_out: true});
    } catch (err) {
        console.error('Portal logout failed:', err.message);
        return res.status(500).json({error: 'logout_failed'});
    }
};

exports.Me = async (req, res) => res.json(await view(req.user, req.portalClient));

/** Sends a reset link if there's an account. The same answer either way. */
exports.ForgotPassword = async (req, res) => {
    const email = emailOf(req.body && req.body.email);
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({error: 'valid_email_required'});
    if (emailSends.blocked(req.ip)) return res.status(429).json({error: 'too_many_attempts'});
    emailSends.hit(req.ip);
    try {
        const user = await db.user.findOne({where: {email}});
        if (user && user.status === 'active') {
            await mailHelper.sendPasswordReset(user, await portalAuth.issueLinkToken(user, 'reset_password'));
        }
        return res.json({sent: true});
    } catch (err) {
        console.error('Password reset request failed:', err.message);
        return res.status(500).json({error: 'reset_failed'});
    }
};

/**
 * Sets a new password from a reset link or an invitation, signs out everywhere else, and signs in.
 * Either link proves the user reads that inbox, so the email counts as confirmed.
 */
exports.ResetPassword = async (req, res) => {
    const body = req.body || {};
    const problem = passwordProblem(body.password);
    if (problem) return res.status(400).json({error: problem});
    try {
        const used = await portalAuth.consumeLinkToken(clean(body.token), ['reset_password', 'invite']);
        if (!used) return res.status(400).json({error: 'invalid_or_expired_link'});
        const {user} = used;
        if (user.status !== 'active') return res.status(400).json({error: 'invalid_or_expired_link'});
        await user.update({password_hash: await passwordHelper.hash(body.password), email_verified_at: user.email_verified_at || new Date()});
        await db.user_session.destroy({where: {user_id: user.id}});
        return res.json(await signedIn(user));
    } catch (err) {
        console.error('Password reset failed:', err.message);
        return res.status(500).json({error: 'reset_failed'});
    }
};

exports.ChangePassword = async (req, res) => {
    const body = req.body || {};
    const problem = passwordProblem(body.new_password);
    if (problem) return res.status(400).json({error: problem});
    try {
        if (!(await passwordHelper.verify(String(body.current_password || ''), req.user.password_hash))) {
            return res.status(400).json({error: 'current_password_wrong'});
        }
        await req.user.update({password_hash: await passwordHelper.hash(body.new_password)});
        // Other devices are signed out; this one stays signed in.
        await db.user_session.destroy({where: {user_id: req.user.id, id: {[db.Sequelize.Op.ne]: req.userSession.id}}});
        return res.json({changed: true});
    } catch (err) {
        console.error('Password change failed:', err.message);
        return res.status(500).json({error: 'change_failed'});
    }
};
