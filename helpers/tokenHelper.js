const crypto = require('crypto');

const TOKEN_PREFIX = 'kyc_';
const PREFIX_LENGTH = 12;

module.exports = {
    /** A new access token: "kyc_" + 32 random bytes, base64url. */
    newToken: function () {
        return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    },

    /** An admin session token, given out by POST /api/admin/login. */
    newSessionToken: function () {
        return 'adm_' + crypto.randomBytes(32).toString('base64url');
    },

    sha256: function (value) {
        return crypto.createHash('sha256').update(value).digest('hex');
    },

    prefixOf: function (token) {
        return token.slice(0, PREFIX_LENGTH);
    },

    /** Compares two secrets without leaking, through timing, how much of them matched. */
    safeEqual: function (a, b) {
        const x = crypto.createHash('sha256').update(String(a)).digest();
        const y = crypto.createHash('sha256').update(String(b)).digest();
        return crypto.timingSafeEqual(x, y);
    },
};
