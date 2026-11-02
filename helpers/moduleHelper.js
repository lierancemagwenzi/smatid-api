const db = require('../models');

// Module keys that some endpoint checks, so the admin API can say which modules are wired up.
const connected = new Set();

module.exports = {
    KEY_PATTERN: /^[a-z0-9]+(-[a-z0-9]+)*$/,
    STATUSES: ['enabled', 'disabled'],

    isConnected: (key) => connected.has(key),

    /**
     * Lets a call through only while the module is enabled. A module that isn't in the table counts
     * as disabled. Goes after requestLog.log, so refused calls still show in the usage log.
     */
    requireModule: function (key) {
        connected.add(key);
        return async function (req, res, next) {
            try {
                const found = await db.kyc_module.findOne({where: {key}});
                if (!found || found.status !== 'enabled') {
                    return res.status(403).json({error: 'module_disabled', module: key});
                }
                next();
            } catch (err) {
                console.error(`Module check for ${key} failed:`, err.message);
                res.status(503).json({error: 'module_check_unavailable'});
            }
        };
    },
};
