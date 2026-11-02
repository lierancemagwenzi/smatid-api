const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const axios = require('axios');

// Waits before each retry: the first send is straight away, then 30 seconds, 5 minutes and 30 minutes.
const RETRY_DELAYS_MS = [30 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const TIMEOUT_MS = 10000;

/** Addresses a webhook must never reach: this machine, private networks, link-local (cloud metadata) and the like. */
function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
    }
    return true;
}

// For local development only: lets webhooks reach http://localhost.
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === 'true';

/**
 * Looks the host up as the connection is made and refuses private addresses then, so a name that
 * resolves somewhere public when checked can't switch to an internal one when used.
 */
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, {...options, all: true}, (err, addresses) => {
        if (err) return callback(err);
        if (!allowPrivate() && addresses.some((a) => isPrivateAddress(a.address))) {
            return callback(Object.assign(new Error(`${hostname} resolves to a private address`), {code: 'private_address'}));
        }
        if (options && options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
    });
}

module.exports = {
    MAX_ATTEMPTS,
    isPrivateAddress,

    /** Why a webhook URL can't be used, or null. Needs https, unless WEBHOOK_ALLOW_PRIVATE is on for local testing. */
    urlProblem: function (value) {
        let url;
        try {
            url = new URL(String(value));
        } catch {
            return 'invalid_webhook_url';
        }
        if (url.username || url.password) return 'invalid_webhook_url';
        if (url.protocol === 'https:') {
            if (!allowPrivate() && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
                return 'webhook_url_not_public';
            }
            if (!allowPrivate() && /^localhost$|\.localhost$|\.local$|\.internal$/i.test(url.hostname)) return 'webhook_url_not_public';
            return null;
        }
        if (url.protocol === 'http:' && allowPrivate()) return null;
        return 'webhook_url_must_be_https';
    },

    newSecret: () => 'whsec_' + crypto.randomBytes(32).toString('base64url'),

    /** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>", the Smatid-Signature header. */
    sign: function (secret, body, timestamp = Math.floor(Date.now() / 1000)) {
        const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
        return `t=${timestamp},v1=${mac}`;
    },

    /** What a client does on its side; here for the tests and the README. */
    verify: function (secret, body, header, toleranceSeconds = 300) {
        const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
        const t = Number(parts.t);
        if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
        const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
        return parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
    },

    /** When to try again after `attempts` failed sends, or null when that was the last try. */
    nextAttemptAt: function (attempts) {
        return attempts < MAX_ATTEMPTS ? new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]) : null;
    },

    /** Sends one webhook. Resolves on a 2xx reply; throws with a short reason otherwise. Never follows redirects. */
    send: async function (url, event, data, secret) {
        const problem = this.urlProblem(url);
        if (problem) throw new Error(problem);
        const body = JSON.stringify({id: 'evt_' + crypto.randomBytes(12).toString('base64url'), event, created_at: new Date().toISOString(), data});
        try {
            const res = await axios.post(url, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Smatid-Webhooks/1.0',
                    'Smatid-Event': event,
                    'Smatid-Signature': this.sign(secret, body),
                },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                maxContentLength: 64 * 1024,
                lookup: safeLookup,
                // Takes the body as it is, so the signature matches what's sent byte for byte.
                transformRequest: [(d) => d],
                validateStatus: () => true,
            });
            if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
            return res.status;
        } catch (err) {
            const reason = err.code === 'private_address' ? 'webhook_url_not_public'
                : err.code === 'ECONNABORTED' ? 'timeout'
                    : err.message;
            throw new Error(String(reason).slice(0, 250));
        }
    },
};
