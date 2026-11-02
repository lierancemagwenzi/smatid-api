const crypto = require('crypto');
const {promisify} = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

module.exports = {
    MIN_LENGTH: 10,

    /** "scrypt$<salt>$<hash>", both base64url. */
    hash: async function (password) {
        const salt = crypto.randomBytes(16);
        const key = await scrypt(password, salt, KEY_LENGTH);
        return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
    },

    verify: async function (password, stored) {
        const [scheme, salt, hash] = String(stored || '').split('$');
        if (scheme !== 'scrypt' || !salt || !hash) return false;
        const expected = Buffer.from(hash, 'base64url');
        const key = await scrypt(String(password), Buffer.from(salt, 'base64url'), expected.length);
        return crypto.timingSafeEqual(key, expected);
    },
};
