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

    // Admin calls carry ADMIN_API_KEY in the X-Admin-Key header. Without the setting, admin is off.
    requireAdmin: function (req, res, next) {
        const key = process.env.ADMIN_API_KEY;
        if (!key) return res.status(503).json({error: 'admin_disabled'});
        if (!tokenHelper.safeEqual(req.get('X-Admin-Key') || '', key)) {
            return res.status(401).json({error: 'unauthorized'});
        }
        next();
    },
};
