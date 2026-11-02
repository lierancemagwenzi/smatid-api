const crypto = require('crypto');
const smatpay = require('../payments/smatpayHelper');
const billing = require('./billingHelper');
const mailHelper = require('../mailHelper');
const db = require('../../models');

// A payment not settled in this long is given up on.
const GIVE_UP_MS = 30 * 60 * 1000;
let polling = false;

const PAID = /^(paid|success|successful|completed)$/i;
const FAILED = /^(failed|failure|cancelled|canceled|expired|timedout|declined|rejected)$/i;

class TopupError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

module.exports = {
    TopupError,

    /** What the portal needs to offer a top-up. */
    options: async function () {
        const cfg = billing.config();
        const methods = Object.entries(smatpay.METHODS)
            .filter(([, m]) => !(m.usdOnly && cfg.currency !== 'USD'))
            .map(([id, m]) => ({id, label: m.label, kind: m.kind, needs_mobile: Boolean(m.mobile)}));
        return {
            available: await smatpay.configured(),
            sandbox: await smatpay.sandbox(),
            currency: cfg.currency,
            credit_price: cfg.credit_price,
            min_credits: cfg.min_credits,
            max_credits: cfg.max_credits,
            packages: cfg.packages.map((credits) => ({credits, amount: billing.priceOf(credits)})),
            methods,
        };
    },

    /** Starts a top-up: records it, then asks Smatpay for the payment. */
    create: async function ({client, user, credits, method, mobile}) {
        const cfg = billing.config();
        credits = Number(credits);
        if (!Number.isInteger(credits) || credits < cfg.min_credits || credits > cfg.max_credits) throw new TopupError('invalid_credits');
        const wallet = smatpay.METHODS[method];
        if (!wallet) throw new TopupError('invalid_method');
        if (wallet.usdOnly && cfg.currency !== 'USD') throw new TopupError('invalid_method');
        let payerMobile = null;
        if (wallet.mobile) {
            payerMobile = smatpay.localNumber(mobile);
            if (!payerMobile || !wallet.mobile.test(payerMobile)) throw new TopupError('invalid_mobile');
        }
        if (!(await smatpay.configured())) throw new TopupError('payments_unavailable');

        const topup = await db.topup.create({
            client_id: client.id, user_id: user ? user.id : null,
            reference: `SMID-${client.id}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
            credits, amount: billing.priceOf(credits), currency: cfg.currency, method, payer_mobile: payerMobile,
        });
        try {
            const init = await smatpay.requestPayment({
                method, amount: topup.amount, currency: topup.currency, payerMobile,
                payerName: (user && user.name) || client.name,
                reference: topup.reference,
                description: `Smatid KYC: ${credits} credits`,
            });
            const url = init.paymentRedirectUrl
                || (method === 'VISA' ? init.paymentVisaSkinnedUrl : null)
                || (method === 'MASTERCARD' ? init.paymentMasterCardSkinnedUrl : null);
            await topup.update({
                // Card payments come back without a paymentReference; their paymentId tracks them.
                payment_reference: init.paymentReference || init.paymentId || init.reference || topup.reference,
                payment_code: init.paymentCode || null,
                payment_url: url && /^https:\/\//i.test(url) ? url : null,
                provider_status: init.status || null,
            });
        } catch (err) {
            await topup.update({status: 'failed', failure_reason: String(err.message).slice(0, 250)});
            throw new TopupError(err.code === 'payments_unavailable' ? 'payments_unavailable' : 'payment_not_started', err.message);
        }
        return topup;
    },

    /**
     * Credits a paid top-up. The top-up row is locked and must still be pending, so a payment seen
     * twice at once (the poller and the person refreshing) is only credited once.
     */
    markPaid: async function (topupId, providerStatus) {
        const credited = await db.sequelize.transaction(async (transaction) => {
            const topup = await db.topup.findByPk(topupId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!topup || topup.status !== 'pending') return null;
            await topup.update({status: 'paid', paid_at: new Date(), provider_status: providerStatus || 'Paid'}, {transaction});
            const {client} = await billing.adjust(topup.client_id, {
                credits: topup.credits, kind: 'topup', topupId: topup.id, userId: topup.user_id,
                description: `Top-up: ${topup.credits} credits (${topup.currency} ${Number(topup.amount).toFixed(2)} by ${smatpay.METHODS[topup.method].label})`,
            }, {transaction});
            return {topup, client};
        });
        if (credited) {
            const user = credited.topup.user_id ? await db.user.findByPk(credited.topup.user_id) : null;
            mailHelper.sendTopupReceipt(user, credited.client, credited.topup)
                .catch((err) => console.error(`Top-up receipt ${credited.topup.reference} failed:`, err.message));
        }
        return credited;
    },

    /** Asks Smatpay where a pending top-up stands, and settles it if it's finished. */
    refresh: async function (topup) {
        if (topup.status !== 'pending') return topup;
        if (Date.now() - new Date(topup.createdAt).getTime() > GIVE_UP_MS) {
            await topup.update({status: 'expired', failure_reason: 'Not paid within 30 minutes'});
            return topup;
        }
        let info;
        try {
            info = await smatpay.trackPayment(topup.payment_reference || topup.reference);
        } catch (err) {
            console.error(`Tracking top-up ${topup.reference} failed:`, err.message);
            return topup;
        }
        const status = String((info && info.status) || 'Pending');
        await topup.update({provider_status: status, checked_at: new Date()});
        if (PAID.test(status)) {
            await this.markPaid(topup.id, status);
            return topup.reload();
        }
        if (FAILED.test(status)) {
            await topup.update({status: 'failed', failure_reason: (info && info.description) || `Payment ${status.toLowerCase()}`});
        } else if (/^refunded$/i.test(status)) {
            await topup.update({status: 'refunded'});
        }
        return topup;
    },

    /** Follows every pending top-up. Run every 20 seconds. */
    poll: async function () {
        if (polling) return;
        polling = true;
        try {
            const pending = await db.topup.findAll({where: {status: 'pending'}, order: [['id', 'ASC']], limit: 50});
            for (const topup of pending) await this.refresh(topup);
        } finally {
            polling = false;
        }
    },

    start: function () {
        const timer = setInterval(() => this.poll().catch((err) => console.error('Top-up poll failed:', err.message)), 20000);
        timer.unref();
        return timer;
    },

    PAID,
    FAILED,
    GIVE_UP_MS,
};
