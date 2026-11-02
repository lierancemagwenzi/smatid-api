const webhookHelper = require('../webhookHelper');
const db = require('../../models');

const {Op} = db.Sequelize;
const SWEEP_MS = 30 * 1000;
let sweeping = false;

const publicBase = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8011}`).replace(/\/$/, '');

/** The client's webhook signing secret, made the first time it's needed. */
async function secretFor(client) {
    if (!client.webhook_secret) await client.update({webhook_secret: webhookHelper.newSecret()});
    return client.webhook_secret;
}

module.exports = {
    secretFor,

    /** A session reached passed, failed or expired: queue its webhook, if it has one, and try it now. */
    finished: async function (session) {
        if (!session.webhook_url) return;
        await session.update({webhook_status: 'pending', webhook_next_at: new Date()});
        this.deliverDue().catch((err) => console.error('Webhook delivery failed:', err.message));
    },

    /** Sends every webhook that's due. One at a time; a second call while one is running does nothing. */
    deliverDue: async function () {
        if (sweeping) return;
        sweeping = true;
        try {
            const due = await db.liveness_session.findAll({
                where: {webhook_status: 'pending', webhook_next_at: {[Op.lte]: new Date()}},
                include: [{model: db.client}],
                order: [['webhook_next_at', 'ASC']],
                limit: 20,
            });
            for (const session of due) {
                const attempts = session.webhook_attempts + 1;
                try {
                    if (!session.client || session.client.status !== 'active') throw new Error('client_not_active');
                    const secret = await secretFor(session.client);
                    await webhookHelper.send(session.webhook_url, 'liveness.completed', session.toPublic(publicBase()), secret);
                    await session.update({
                        webhook_status: 'delivered', webhook_attempts: attempts, webhook_next_at: null,
                        webhook_delivered_at: new Date(), webhook_last_error: null,
                    });
                } catch (err) {
                    const next = err.message === 'client_not_active' ? null : webhookHelper.nextAttemptAt(attempts);
                    await session.update({
                        webhook_status: next ? 'pending' : 'failed', webhook_attempts: attempts,
                        webhook_next_at: next, webhook_last_error: err.message,
                    });
                    console.error(`Webhook for ${session.public_id} failed (try ${attempts}):`, err.message);
                }
            }
        } finally {
            sweeping = false;
        }
    },

    /** Marks sessions whose time ran out as expired, which also sends their webhook. */
    expireStale: async function () {
        const stale = await db.liveness_session.findAll({
            where: {status: {[Op.in]: ['pending', 'started']}, expires_at: {[Op.lte]: new Date()}},
            limit: 100,
        });
        for (const session of stale) {
            await session.update({status: 'expired', completed_at: new Date()});
            if (session.webhook_url) await session.update({webhook_status: 'pending', webhook_next_at: new Date()});
        }
        return stale.length;
    },

    /** Runs expiry and webhook sending every 30 seconds, so nothing is lost across a restart. */
    start: function () {
        const sweep = async () => {
            try {
                await this.expireStale();
                await this.deliverDue();
            } catch (err) {
                console.error('Liveness sweep failed:', err.message);
            }
        };
        const timer = setInterval(sweep, SWEEP_MS);
        timer.unref();
        setTimeout(sweep, 5000).unref();
        return timer;
    },
};
