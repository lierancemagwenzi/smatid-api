const settings = require('../helpers/settingsHelper');
const smatpay = require('../helpers/payments/smatpayHelper');

const {FIELDS} = smatpay;
const PLAIN = ['plane', 'api_url', 'merchant_id', 'account_id', 'profile_number'];
const SECRET = Object.keys(FIELDS).filter((f) => FIELDS[f].secret);

/** Why a plain value can't be saved, or null. Empty values are allowed: they clear the setting. */
function problem(field, value) {
    if (value === null || value === '') return null;
    const v = String(value).trim();
    if (field === 'plane' && !['sandbox', 'production'].includes(v)) return 'plane_must_be_sandbox_or_production';
    if (field === 'api_url') {
        try {
            const url = new URL(v);
            if (url.protocol !== 'https:') return 'api_url_must_be_https';
        } catch {
            return 'invalid_api_url';
        }
    }
    if (field === 'merchant_id' && !/^[A-Za-z0-9-]{4,64}$/.test(v)) return 'invalid_merchant_id';
    if (field === 'account_id' && !/^\d{1,20}$/.test(v)) return 'invalid_account_id';
    if (field === 'profile_number' && !/^\d{1,20}$/.test(v)) return 'invalid_profile_number';
    return null;
}

/** The payment settings as the admin site shows them. Keys are never sent back, only whether they're set. */
async function view() {
    const {values, sources} = await smatpay.loadSettings();
    const keys = {};
    for (const field of SECRET) {
        const value = values[field];
        keys[field] = {set: Boolean(value), last4: value ? String(value).slice(-4) : null, source: sources[field]};
    }
    return {
        plane: values.plane,
        api_url: values.api_url,
        merchant_id: values.merchant_id,
        account_id: values.account_id,
        profile_number: values.profile_number,
        keys,
        sources: Object.fromEntries(PLAIN.map((f) => [f, sources[f]])),
        configured: await smatpay.configured(),
        encryption_ready: settings.encryptionReady(),
        updated_at: await settings.updatedAt(Object.values(FIELDS).map((d) => d.key)),
    };
}

exports.Payments = async (req, res) => {
    try {
        return res.json(await view());
    } catch (err) {
        console.error('Payment settings failed:', err.message);
        return res.status(500).json({error: 'settings_failed'});
    }
};

/**
 * Saves payment settings. Plain fields: a value sets it, null or "" clears it (falling back to the
 * environment). Keys: a value replaces it, null clears it, and leaving it out (or "") keeps it.
 */
exports.SavePayments = async (req, res) => {
    const body = req.body || {};
    const values = {};
    for (const field of PLAIN) {
        if (body[field] === undefined) continue;
        const why = problem(field, body[field]);
        if (why) return res.status(400).json({error: why});
        values[FIELDS[field].key] = body[field] === null ? null : String(body[field]).trim();
    }
    for (const field of SECRET) {
        const value = body[field];
        if (value === undefined || value === '') continue;
        if (value !== null && (typeof value !== 'string' || value.trim().length < 4 || value.length > 512)) {
            return res.status(400).json({error: `invalid_${field}`});
        }
        values[FIELDS[field].key] = value === null ? null : value.trim();
    }
    if (!Object.keys(values).length) return res.status(400).json({error: 'nothing_to_update'});
    try {
        await settings.set(values, {secret: SECRET.map((f) => FIELDS[f].key), adminId: req.admin ? req.admin.id : null});
        return res.json(await view());
    } catch (err) {
        if (err.code === 'encryption_key_missing') return res.status(503).json({error: 'encryption_key_missing'});
        console.error('Saving payment settings failed:', err.message);
        return res.status(500).json({error: 'settings_save_failed'});
    }
};

/** Signs in to Smatpay with the saved details, or with unsaved ones from the form, and lists the payment profiles. */
exports.TestPayments = async (req, res) => {
    const body = req.body || {};
    const overrides = {};
    for (const field of [...PLAIN, ...SECRET]) {
        const value = body[field];
        if (value === undefined || value === null || value === '') continue;
        if (PLAIN.includes(field)) {
            const why = problem(field, value);
            if (why) return res.status(400).json({error: why});
        }
        overrides[field] = String(value).trim();
    }
    try {
        return res.json({ok: true, ...(await smatpay.checkConnection(overrides))});
    } catch (err) {
        if (err instanceof smatpay.PaymentError) return res.status(400).json({ok: false, error: err.code, message: err.message});
        console.error('Payment settings check failed:', err.message);
        return res.status(500).json({error: 'settings_check_failed'});
    }
};
