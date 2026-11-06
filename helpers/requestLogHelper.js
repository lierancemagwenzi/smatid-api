const db = require('../models');

/** Drops empty objects, so a GET doesn't store "body": {}. Body fields in `redact` are kept out of the log. */
function searched(req, redact = []) {
    let body = req.body;
    if (body && typeof body === 'object' && redact.length) {
        body = {...body};
        for (const key of redact) {
            if (typeof body[key] === 'string') body[key] = `[${Math.round(body[key].length * 0.75 / 1024)} KB, not logged]`;
            else if (body[key] && typeof body[key] === 'object') body[key] = `[${Object.keys(body[key]).join(', ')}, not logged]`;
            else if (key in body) body[key] = '[not logged]';
        }
    }
    const parts = {params: req.params, query: req.query, body};
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
     * `redact` names body fields too big or sensitive to keep, like a picture.
     */
    log: function (check, {redact = []} = {}) {
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
                    request: searched(req, redact),
                    status: res.statusCode,
                    response: res.locals.responseBody === undefined ? null : res.locals.responseBody,
                    duration_ms: Date.now() - started,
                    ip: req.ip,
                    credits_charged: res.locals.creditsCharged || 0,
                }).catch((err) => console.error(`Could not log ${check} request:`, err.message));
            });
            next();
        };
    },
};
