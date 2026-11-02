/**
 * Lets the admin site (its own origin, e.g. https://kyc.smatid.com) call this API from the browser.
 * CORS_ORIGINS is a comma-separated list of exact origins. Auth is a Bearer header, never cookies,
 * so credentials are not allowed.
 */
module.exports = {
    allowOrigins: function () {
        const allowed = new Set((process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean));
        return function (req, res, next) {
            const origin = req.get('Origin');
            if (origin && allowed.has(origin)) {
                res.set('Access-Control-Allow-Origin', origin);
                res.vary('Origin');
                if (req.method === 'OPTIONS') {
                    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
                    res.set('Access-Control-Max-Age', '600');
                    return res.sendStatus(204);
                }
            }
            next();
        };
    },
};
