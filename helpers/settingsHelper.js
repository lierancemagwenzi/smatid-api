const crypto = require('crypto');
const db = require('../models');

// Saved values are read often (every top-up check), so they're kept for a short while.
const CACHE_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

const ENCRYPTED = 'enc:';

/** The key secret settings are encrypted with: SETTINGS_ENCRYPTION_KEY, 32 bytes, base64. */
function encryptionKey() {
    const key = Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || '', 'base64');
    return key.length === 32 ? key : null;
}

function encrypt(plain) {
    const key = encryptionKey();
    if (!key) throw Object.assign(new Error('SETTINGS_ENCRYPTION_KEY is not set'), {code: 'encryption_key_missing'});
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ENCRYPTED + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

function decrypt(stored) {
    const key = encryptionKey();
    if (!key) throw Object.assign(new Error('SETTINGS_ENCRYPTION_KEY is not set'), {code: 'encryption_key_missing'});
    const [iv, tag, body] = stored.slice(ENCRYPTED.length).split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function all() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
    const rows = await db.setting.findAll();
    cache = new Map(rows.map((r) => [r.key, r.value]));
    cachedAt = Date.now();
    return cache;
}

module.exports = {
    encryptionReady: () => Boolean(encryptionKey()),

    /** A setting's value (decrypted if it's secret), or null. */
    get: async function (key) {
        const value = (await all()).get(key);
        if (value === undefined || value === null || value === '') return null;
        if (value.startsWith(ENCRYPTED)) {
            try {
                return decrypt(value);
            } catch (err) {
                console.error(`Setting ${key} couldn’t be decrypted (was SETTINGS_ENCRYPTION_KEY changed?):`, err.message);
                return null;
            }
        }
        return value;
    },

    /**
     * Saves settings: {key: value}. A null or '' value deletes the setting. Keys listed in `secret`
     * are stored encrypted. Throws encryption_key_missing if a secret is given without the key.
     */
    set: async function (values, {secret = [], adminId = null} = {}) {
        await db.sequelize.transaction(async (transaction) => {
            for (const [key, value] of Object.entries(values)) {
                if (value === null || value === undefined || value === '') {
                    await db.setting.destroy({where: {key}, transaction});
                } else {
                    const stored = secret.includes(key) ? encrypt(value) : String(value);
                    await db.setting.upsert({key, value: stored, updated_by_admin_id: adminId}, {transaction});
                }
            }
        });
        this.forget();
    },

    /** Drops the cache, so the next read sees the database. */
    forget: () => {
        cache = null;
    },

    /** When a setting was last changed, for showing in the admin site. */
    updatedAt: async function (keys) {
        const rows = await db.setting.findAll({where: {key: keys}, attributes: ['updated_at'], order: [['updated_at', 'DESC']], limit: 1});
        return rows.length ? rows[0].get('updated_at') : null;
    },
};
