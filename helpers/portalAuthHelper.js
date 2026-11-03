const crypto = require('crypto');
const tokenHelper = require('./tokenHelper');
const db = require('../models');

const SESSION_HOURS = () => Number(process.env.PORTAL_SESSION_HOURS || 24);

// How long each kind of emailed link works.
const LINK_HOURS = {verify_email: 24, reset_password: 1, invite: 24 * 7};

function bearerToken(req) {
    const m = (req.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
    return m ? m[1] : null;
}

module.exports = {
    LINK_HOURS,

    /** A signed-in session for a user: {token, expires_at}. Only the token's hash is kept. */
    startSession: async function (user) {
        const token = 'usr_' + crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SESSION_HOURS() * 3600 * 1000);
        await db.user_session.create({user_id: user.id, token_hash: tokenHelper.sha256(token), expires_at: expiresAt});
        await user.update({last_login_at: new Date()});
        return {token, expires_at: expiresAt};
    },

    /** A one-time link token. Any earlier unused one for the same purpose stops working. */
    issueLinkToken: async function (user, purpose) {
        await db.user_token.update({used_at: new Date()}, {where: {user_id: user.id, purpose, used_at: null}});
        const token = crypto.randomBytes(32).toString('base64url');
        await db.user_token.create({
            user_id: user.id, purpose, token_hash: tokenHelper.sha256(token),
            expires_at: new Date(Date.now() + LINK_HOURS[purpose] * 3600 * 1000),
        });
        return token;
    },

    /** Uses up a link token: its user, if it's real, unused, unexpired and for one of `purposes`; otherwise null. */
    consumeLinkToken: async function (token, purposes) {
        if (!token || typeof token !== 'string') return null;
        const row = await db.user_token.findOne({where: {token_hash: tokenHelper.sha256(token)}, include: [{model: db.user}]});
        if (!row || row.used_at || new Date(row.expires_at) <= new Date() || !purposes.includes(row.purpose) || !row.user) return null;
        await row.update({used_at: new Date()});
        return {user: row.user, purpose: row.purpose};
    },

    /** Portal calls carry the user's session: "Authorization: Bearer usr_...". Sets req.user and req.portalClient. */
    requireUser: async function (req, res, next) {
        const token = bearerToken(req);
        if (!token || !token.startsWith('usr_')) return res.status(401).json({error: 'unauthorized'});
        try {
            const session = await db.user_session.findOne({
                where: {token_hash: tokenHelper.sha256(token)},
                include: [{model: db.user, include: [{model: db.client}]}],
            });
            const user = session && session.user;
            if (!session || !user || new Date(session.expires_at) <= new Date() || user.status !== 'active' || !user.client) {
                return res.status(401).json({error: 'unauthorized'});
            }
            if (user.client.status !== 'active') return res.status(403).json({error: 'account_suspended'});
            req.user = user;
            req.portalClient = user.client;
            req.userSession = session;
            next();
        } catch (err) {
            console.error('Portal session lookup failed:', err.message);
            res.status(503).json({error: 'auth_unavailable'});
        }
    },

    /** After requireUser: lets the KYC check middleware (log, module, charge) treat the user's company as the client. */
    asClient: function (req, res, next) {
        req.client = req.portalClient;
        next();
    },

    /** After requireUser: only the client's owners. */
    requireOwner: function (req, res, next) {
        if (!req.user.isOwner()) return res.status(403).json({error: 'owner_only'});
        next();
    },
};
