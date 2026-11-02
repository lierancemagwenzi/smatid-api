const db = require('../../models');

const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};

class InsufficientCredits extends Error {
    constructor(needed, available) {
        super('insufficient_credits');
        this.needed = needed;
        this.available = available;
    }
}

/** Takes away expired trial credits, writing it in the ledger. Inside a transaction with the client locked. */
async function expireTrial(client, transaction) {
    if (!client.trial_credits || client.trialActive()) return;
    const expired = client.trial_credits;
    await client.update({trial_credits: 0}, {transaction});
    await db.credit_transaction.create({
        client_id: client.id, kind: 'trial_expiry', credits: 0, trial_credits: -expired,
        credits_after: client.credits, trial_credits_after: 0,
        description: `Free trial ended: ${expired} unused credits expired`,
    }, {transaction});
}

module.exports = {
    InsufficientCredits,

    /** Prices and limits, from the settings. */
    config: function () {
        const packages = String(process.env.CREDIT_PACKAGES || '100,500,1000,5000')
            .split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0);
        return {
            trial_days: num('TRIAL_DAYS', 30),
            trial_credits: num('TRIAL_CREDITS', 50),
            credit_price: num('CREDIT_PRICE', 0.1),
            currency: process.env.CREDIT_CURRENCY || 'USD',
            packages,
            min_credits: num('TOPUP_MIN_CREDITS', 50),
            max_credits: num('TOPUP_MAX_CREDITS', 100000),
        };
    },

    /** What `credits` cost, rounded to the cent. */
    priceOf: function (credits) {
        return Math.round(credits * this.config().credit_price * 100) / 100;
    },

    /**
     * Changes a client's credits and writes the ledger, with the client's row locked so two changes at
     * once can't both read the old balance. Neither pot may go below zero. Returns the updated client.
     */
    adjust: async function (clientId, {credits = 0, trialCredits = 0, kind, description, checkType = null, topupId = null, adminId = null, userId = null}, options = {}) {
        const run = async (transaction) => {
            const client = await db.client.findByPk(clientId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!client) throw Object.assign(new Error('client_not_found'), {code: 'client_not_found'});
            const nextCredits = client.credits + credits;
            const nextTrial = client.trial_credits + trialCredits;
            if (nextCredits < 0 || nextTrial < 0) throw Object.assign(new Error('balance_would_go_negative'), {code: 'balance_would_go_negative'});
            await client.update({credits: nextCredits, trial_credits: nextTrial}, {transaction});
            const entry = await db.credit_transaction.create({
                client_id: client.id, kind, credits, trial_credits: trialCredits,
                credits_after: nextCredits, trial_credits_after: nextTrial,
                description, check_type: checkType, topup_id: topupId, admin_id: adminId, user_id: userId,
            }, {transaction});
            return {client, entry};
        };
        return options.transaction ? run(options.transaction) : db.sequelize.transaction(run);
    },

    /** Starts the free trial, once: trial credits that last TRIAL_DAYS. */
    startTrial: async function (clientId) {
        const {trial_days: days, trial_credits: credits} = this.config();
        return db.sequelize.transaction(async (transaction) => {
            const client = await db.client.findByPk(clientId, {transaction, lock: transaction.LOCK.UPDATE});
            if (!client || client.trial_until) return client;
            await client.update({trial_until: new Date(Date.now() + days * 86400000)}, {transaction});
            if (credits > 0) {
                await this.adjust(client.id, {
                    trialCredits: credits, kind: 'trial_grant', description: `Free trial: ${credits} credits for ${days} days`,
                }, {transaction});
            }
            return client.reload({transaction});
        });
    },

    /**
     * Sets aside `cost` credits for a check before it runs: trial credits first while the trial lasts,
     * then paid ones. Throws InsufficientCredits when there aren't enough. Returns what was taken.
     */
    reserve: async function (clientId, cost, checkType) {
        return db.sequelize.transaction(async (transaction) => {
            const client = await db.client.findByPk(clientId, {transaction, lock: transaction.LOCK.UPDATE});
            await expireTrial(client, transaction);
            const fromTrial = Math.min(client.trialActive() ? client.trial_credits : 0, cost);
            const fromPaid = cost - fromTrial;
            if (fromPaid > client.credits) throw new InsufficientCredits(cost, client.balance().available_credits);
            const {entry} = await this.adjust(client.id, {
                credits: -fromPaid, trialCredits: -fromTrial, kind: 'usage', checkType,
                description: `${checkType} check`,
            }, {transaction});
            return {fromPaid, fromTrial, cost, entryId: entry.id};
        });
    },

    /** Gives back a reservation for a check that didn't complete. */
    refund: async function (clientId, reservation, checkType, reason) {
        return this.adjust(clientId, {
            credits: reservation.fromPaid, trialCredits: reservation.fromTrial, kind: 'refund', checkType,
            description: `Refund: ${checkType} check ${reason || 'did not complete'}`,
        });
    },

    /** Whether a reply means the check was done, and so is charged. A company that isn't on the register still is. */
    chargeable: (checkType, status) => (status >= 200 && status < 300) || (checkType === 'company' && status === 404),

    /**
     * Charges a check its module's credit cost. Goes after requireModule (which finds the module).
     * Credits are reserved first, so two calls can't spend the same credit, and refunded if the reply
     * says the check didn't happen (a bad request, a source being down, …).
     */
    charge: function (checkType) {
        const self = this;
        return async function (req, res, next) {
            const cost = req.kycModule ? req.kycModule.credit_cost : 0;
            if (!cost || cost <= 0) return next();
            let reservation;
            try {
                reservation = await self.reserve(req.client.id, cost, checkType);
            } catch (err) {
                if (err instanceof InsufficientCredits) {
                    return res.status(402).json({error: 'insufficient_credits', credits_needed: err.needed, available_credits: err.available});
                }
                console.error('Credit check failed:', err.message);
                return res.status(503).json({error: 'billing_unavailable'});
            }
            const json = res.json.bind(res);
            res.json = (body) => {
                const charged = self.chargeable(checkType, res.statusCode);
                res.locals.creditsCharged = charged ? cost : 0;
                if (!charged) {
                    self.refund(req.client.id, reservation, checkType, `answered ${res.statusCode}`)
                        .catch((err) => console.error(`Refund for client ${req.client.id} failed:`, err.message));
                }
                return json(body);
            };
            next();
        };
    },
};
