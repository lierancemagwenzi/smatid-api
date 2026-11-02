const axios = require('axios');
const settings = require('../settingsHelper');

/**
 * Taking payments as a Smatpay merchant, the way smatpay_whatsapp, tese and the NetOne bot do:
 * /init/authenticate/merchant/wallet to ask for a payment, /init/trackPaymentTransaction to follow it.
 * In the sandbox plane, payments are simulated.
 *
 * The merchant's details are set by an admin (Settings → Payments, stored in the settings table, keys
 * encrypted). Anything not set there falls back to the SMATPAY_* environment settings.
 */

// What clients can pay with. `mobile`: the wallet's own numbers, for a prompt on the phone.
const METHODS = {
    ECOCASH: {walletName: 'Ecocash', label: 'EcoCash', mobile: /^07[78]\d{7}$/, kind: 'prompt'},
    OMARI: {walletName: 'Omari', label: 'O’mari', mobile: /^071\d{7}$/, kind: 'prompt'},
    INNBUCKS: {walletName: 'Innbucks', label: 'InnBucks', usdOnly: true, kind: 'code'},
    VISA: {walletName: 'Visa', label: 'Visa', kind: 'card'},
    MASTERCARD: {walletName: 'Mastercard', label: 'Mastercard', kind: 'card'},
    ZIMSWITCH: {walletName: 'ZimSwitch', label: 'ZimSwitch', kind: 'card'},
};

// Each setting: its key in the settings table, the environment fallback, and whether it's secret.
const FIELDS = {
    plane: {key: 'smatpay.plane', env: ['SMATPAY_PLANE']},
    api_url: {key: 'smatpay.api_url', env: ['SMATPAY_API_URL']},
    merchant_id: {key: 'smatpay.merchant_id', env: ['SMATPAY_MERCHANT_ID']},
    account_id: {key: 'smatpay.account_id', env: ['SMATPAY_MERCHANT_ACCOUNT_ID']},
    profile_number: {key: 'smatpay.profile_number', env: ['SMATPAY_PROFILE_NUMBER']},
    sandbox_merchant_key: {key: 'smatpay.sandbox_merchant_key', env: ['SMATPAY_SANDBOX_MERCHANT_KEY'], secret: true},
    sandbox_api_key: {key: 'smatpay.sandbox_api_key', env: ['SMATPAY_SANDBOX_MERCHANT_API_KEY'], secret: true},
    production_merchant_key: {key: 'smatpay.production_merchant_key', env: ['SMATPAY_MERCHANT_KEY'], secret: true},
    production_api_key: {key: 'smatpay.production_api_key', env: ['SMATPAY_MERCHANT_API_KEY'], secret: true},
};

class PaymentError extends Error {
    constructor(message, code = 'payment_failed') {
        super(message);
        this.code = code;
    }
}

/** Every field's value and where it came from: {values: {field: value}, sources: {field: 'admin'|'environment'|null}}. */
async function loadSettings() {
    const values = {};
    const sources = {};
    for (const [field, def] of Object.entries(FIELDS)) {
        const saved = await settings.get(def.key);
        const fromEnv = def.env.map((name) => process.env[name]).find((v) => v);
        values[field] = saved || fromEnv || null;
        sources[field] = saved ? 'admin' : fromEnv ? 'environment' : null;
    }
    values.plane = values.plane === 'production' ? 'production' : 'sandbox';
    return {values, sources};
}

/** The merchant details for the current plane, ready to use. */
async function merchant(overrides) {
    const {values} = await loadSettings();
    const v = {...values, ...(overrides || {})};
    const sandbox = v.plane !== 'production';
    return {
        sandbox,
        apiUrl: String(v.api_url || '').replace(/\/+$/, ''),
        merchantId: v.merchant_id,
        merchantKey: sandbox ? v.sandbox_merchant_key : v.production_merchant_key,
        merchantApiKey: sandbox ? v.sandbox_api_key : v.production_api_key,
        accountId: v.account_id,
        profileNumber: v.profile_number,
    };
}

async function call(m, method, path, body, timeoutMs, headers = {}) {
    let res;
    try {
        res = await axios({method, url: `${m.apiUrl}${path}`, data: body, timeout: timeoutMs, validateStatus: () => true, headers: {Accept: 'application/json', ...headers}});
    } catch (err) {
        throw new PaymentError(err.code === 'ECONNABORTED' ? 'Smatpay took too long to answer.' : 'Smatpay couldn’t be reached.', 'payments_unavailable');
    }
    if (res.status >= 500) throw new PaymentError('Smatpay is having trouble right now.', 'payments_unavailable');
    return res;
}

module.exports = {
    METHODS,
    FIELDS,
    PaymentError,
    loadSettings,
    merchant,

    sandbox: async () => (await merchant()).sandbox,

    /** Whether everything needed to take payments is set. */
    configured: async function () {
        const m = await merchant();
        return Boolean(m.apiUrl && m.merchantId && m.merchantKey && m.merchantApiKey && m.accountId && m.profileNumber);
    },

    /** 0771234567 or +263771234567 → 0771234567; anything else → null. */
    localNumber: function (value) {
        const digits = String(value || '').replace(/[\s()-]/g, '');
        if (/^\+?2637\d{8}$/.test(digits)) return `0${digits.replace(/^\+?263/, '')}`;
        return /^07\d{8}$/.test(digits) ? digits : null;
    },

    /**
     * Asks a payer for money. Resolves to Smatpay's initiation: {status, paymentReference, paymentId,
     * paymentCode, paymentRedirectUrl, paymentVisaSkinnedUrl, …}.
     */
    requestPayment: async function ({method, amount, currency, payerName, reference, payerMobile, description}) {
        const m = await merchant();
        const res = await call(m, 'post', m.sandbox ? '/sandbox/init/authenticate/merchant/wallet' : '/init/authenticate/merchant/wallet', {
            merchantId: m.merchantId, merchantKey: m.merchantKey, merchantApiKey: m.merchantApiKey,
            walletName: METHODS[method].walletName,
            amount: Number(amount).toFixed(2),
            paymentCurrency: currency,
            paymentDescription: description,
            payerName,
            payerReference: reference,
            payerAccountId: String(m.accountId),
            profileId: Number(m.profileNumber),
            ...(payerMobile ? {payerMobile: `+263${payerMobile.slice(1)}`} : {}),
        }, 60000);
        const data = res.data;
        const init = data && data.paymentInitiationResponse;
        const failure = (data && data.auth && data.auth.errorResponse && data.auth.errorResponse.errorMessage)
            || (data && data.errorResponse && data.errorResponse.errorMessage);
        if (!init || /^(failed|failure|error|rejected)$/i.test(init.status || '')) {
            throw new PaymentError((init && init.paymentResponseMessage) || failure || 'The payment couldn’t be started.');
        }
        return init;
    },

    /** Where a payment stands: {status: Pending | Paid | Failed | Cancelled | REFUNDED…, …} or null. */
    trackPayment: async function (reference) {
        const m = await merchant();
        const res = await call(m, 'post', `${m.sandbox ? '/sandbox/init' : '/init'}/trackPaymentTransaction`, {transactionReference: reference}, 15000);
        const rows = res.data;
        if (!Array.isArray(rows)) return null;
        return rows.find((r) => r.paymentReference === reference) || rows[0] || null;
    },

    /**
     * Checks merchant details by signing in with the keys, then reads the merchant's account and
     * payment profiles. `overrides` are unsaved values from the admin form. Resolves to
     * {plane, merchant: {name, approved, account_id}, profiles: [{number, name, approved}]};
     * throws PaymentError with Smatpay's reason when the keys are refused.
     */
    checkConnection: async function (overrides) {
        const m = await merchant(overrides);
        if (!m.apiUrl) throw new PaymentError('Set the Smatpay API address first.', 'incomplete');
        if (!m.merchantId || !m.merchantKey || !m.merchantApiKey) throw new PaymentError(`Set the merchant ID and the ${m.sandbox ? 'sandbox' : 'production'} keys first.`, 'incomplete');
        const keys = {merchantId: m.merchantId, merchantKey: m.merchantKey, merchantApiKey: m.merchantApiKey};

        const login = await call(m, 'post', m.sandbox ? '/auth/authenticate/sandbox/merchant' : '/auth/authenticate/merchant', keys, 20000);
        const token = login.data && login.data.token;
        if (!token) {
            const reason = login.data && login.data.errorResponse && login.data.errorResponse.errorMessage;
            throw new PaymentError(reason || 'Smatpay didn’t accept these keys.', 'keys_refused');
        }
        const profileRes = await call(m, 'post', m.sandbox ? '/auth/authenticate/sandbox/merchant/profile' : '/auth/authenticate/merchant/profile', keys, 20000);
        const account = (profileRes.data && profileRes.data.data) || {};
        const accountId = account.id || m.accountId;
        let profiles = [];
        if (accountId) {
            const res = await call(m, 'get', `${m.sandbox ? '/api/merchant/sandbox/paymentprofile/' : '/api/merchant/paymentprofile/'}${accountId}`, undefined, 20000, {Authorization: `Bearer ${token}`});
            profiles = Array.isArray(res.data) ? res.data : [];
        }
        return {
            plane: m.sandbox ? 'sandbox' : 'production',
            merchant: {
                name: account.tradingName || account.registeredLegalCompanyName || null,
                approved: account.accountApproved === true,
                account_id: accountId ? String(accountId) : null,
            },
            profiles: profiles.map((p) => ({number: p.paymentProfileNumber ? String(p.paymentProfileNumber) : null, name: p.paymentProfileName || null, approved: p.paymentProfileApproved !== false})),
        };
    },
};
