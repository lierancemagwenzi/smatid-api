const db = require('../models');

/** Drops empty objects, so a GET doesn't store "body": {}. */
function searched(req) {
    const parts = {params: req.params, query: req.query, body: req.body};
    const out = {};
    for (const [key, value] of Object.entries(parts)) {
        if (value && typeof value === 'object' && Object.keys(value).length) out[key] = {...value};
    }
    return out;
}

module.exports = {
    /**
     * Records each KYC call in api_requests once the reply has gone out. Goes after
     * requireClient, so every row has a client. A failed write is logged, never sent to the client.
     */
    log: function (check) {
        return function (req, res, next) {
            const started = Date.now();
            const json = res.json.bind(res);
            res.json = (body) => {
                res.locals.responseBody = body;
                return json(body);
            };
            res.on('finish', () => {
                db.api_request.create({
                    client_id: req.client.id,
                    check_type: check,
                    method: req.method,
                    path: req.originalUrl.slice(0, 512),
                    request: searched(req),
                    status: res.statusCode,
                    response: res.locals.responseBody === undefined ? null : res.locals.responseBody,
                    duration_ms: Date.now() - started,
                    ip: req.ip,
                }).catch((err) => console.error(`Could not log ${check} request:`, err.message));
            });
            next();
        };
    },
};
