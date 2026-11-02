const tokenHelper = require('./tokenHelper');
const db = require('../models');

function bearerToken(req) {
    const m = (req.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
    return m ? m[1] : null;
}

module.exports = {
    // KYC calls carry a client's access token: "Authorization: Bearer kyc_...".
    requireClient: async function (req, res, next) {
        const token = bearerToken(req);
        if (!token) return res.status(401).json({error: 'missing_access_token'});

        try {
            const client = await db.client.findOne({where: {token_hash: tokenHelper.sha256(token)}});
            if (!client || client.status !== 'active') {
                return res.status(401).json({error: 'invalid_access_token'});
            }
            req.client = client;
            // Not awaited: a slow write shouldn't hold up the check. silent keeps updated_at as it was.
            client.update({last_used_at: new Date()}, {silent: true})
                .catch((err) => console.error('Could not record client use:', err.message));
            next();
        } catch (err) {
            console.error('Client lookup failed:', err.message);
            res.status(503).json({error: 'auth_unavailable'});
        }
    },

    /**
     * Admin calls carry either a session token from POST /api/admin/login ("Authorization: Bearer adm_..."),
     * which is what the /admin pages use, or ADMIN_API_KEY in the X-Admin-Key header, for scripts.
     * Without ADMIN_API_KEY set, the header is refused and only sign-in works.
     */
    requireAdmin: async function (req, res, next) {
        const key = req.get('X-Admin-Key');
        if (key !== undefined) {
            if (!process.env.ADMIN_API_KEY) return res.status(503).json({error: 'admin_key_disabled'});
            if (!tokenHelper.safeEqual(key, process.env.ADMIN_API_KEY)) {
                return res.status(401).json({error: 'unauthorized'});
            }
            req.admin = null;
            return next();
        }

        const token = bearerToken(req);
        if (!token) return res.status(401).json({error: 'unauthorized'});
        try {
            const session = await db.admin_session.findOne({
                where: {token_hash: tokenHelper.sha256(token)},
                include: [db.admin],
            });
            if (!session || !session.admin || new Date(session.expires_at) <= new Date()) {
                return res.status(401).json({error: 'unauthorized'});
            }
            req.admin = session.admin;
            req.adminSession = session;
            next();
        } catch (err) {
            console.error('Admin session lookup failed:', err.message);
            res.status(503).json({error: 'auth_unavailable'});
        }
    },
};
