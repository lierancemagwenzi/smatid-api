const tokenHelper = require('../helpers/tokenHelper');
const webhookHelper = require('../helpers/webhookHelper');
const mailHelper = require('../helpers/mailHelper');
const billing = require('../helpers/billing/billingHelper');
const portalAuth = require('../helpers/portalAuthHelper');
const db = require('../models');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates a client and its first portal user (the owner, on the client's email). One email gets them
 * both: the API token, and a link to set a password for the client portal.
 */
exports.Create = async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase() || null;
    const contactName = String((req.body && req.body.contact_name) || '').trim() || name;
    if (!name || name.length > 255) return res.status(400).json({error: 'name_required'});
    // The token is emailed to the client, so an address is needed.
    if (!email || !EMAIL_PATTERN.test(email)) return res.status(400).json({error: 'valid_email_required'});
    if (contactName.length > 255) return res.status(400).json({error: 'contact_name_too_long'});

    try {
        // A person has one portal account, so the email can't already be someone's sign-in.
        if (await db.user.findOne({where: {email}})) return res.status(409).json({error: 'email_taken'});
        const token = tokenHelper.newToken();
        const {client, user} = await db.sequelize.transaction(async (transaction) => {
            const made = await db.client.create({
                name,
                email,
                token_hash: tokenHelper.sha256(token),
                token_prefix: tokenHelper.prefixOf(token),
            }, {transaction});
            const owner = await db.user.create({client_id: made.id, name: contactName, email, role: 'owner'}, {transaction});
            return {client: made, user: owner};
        });
        await billing.startTrial(client.id);
        await client.reload();
        const setupToken = await portalAuth.issueLinkToken(user, 'invite');
        // A failed email doesn't undo the client: the admin still gets the token here and can pass it on.
        const emailSent = await mailHelper.sendAccessToken(client, token, `${mailHelper.portalUrl()}/accept-invite?token=${encodeURIComponent(setupToken)}`);
        // The only time the token is ever shown.
        return res.status(201).json({client: client.toPublic(), user: user.toPublic(), access_token: token, email_sent: emailSent});
    } catch (err) {
        console.error('Client create failed:', err.message);
        return res.status(500).json({error: 'client_create_failed'});
    }
};

/** Calls per client and when each last made one. */
async function usageByClient(clientIds) {
    const {fn, col, Op} = db.Sequelize;
    const rows = await db.api_request.findAll({
        where: clientIds ? {client_id: {[Op.in]: clientIds}} : undefined,
        attributes: ['client_id', [fn('COUNT', col('id')), 'requests'], [fn('MAX', col('created_at')), 'last_request_at']],
        group: ['client_id'],
        raw: true,
    });
    return new Map(rows.map((r) => [r.client_id, {requests: Number(r.requests), last_request_at: r.last_request_at}]));
}

const NO_USAGE = {requests: 0, last_request_at: null};

exports.List = async (req, res) => {
    try {
        const clients = await db.client.findAll({order: [['id', 'ASC']]});
        const usage = await usageByClient();
        return res.json({clients: clients.map((c) => ({...c.toPublic(), ...(usage.get(c.id) || NO_USAGE)}))});
    } catch (err) {
        console.error('Client list failed:', err.message);
        return res.status(500).json({error: 'client_list_failed'});
    }
};

exports.Show = async (req, res) => {
    try {
        const client = await db.client.findByPk(req.params.id);
        if (!client) return res.status(404).json({error: 'client_not_found'});
        const usage = await usageByClient([client.id]);
        return res.json({client: {...client.toPublic(), ...(usage.get(client.id) || NO_USAGE)}});
    } catch (err) {
        console.error('Client show failed:', err.message);
        return res.status(500).json({error: 'client_show_failed'});
    }
};

/** Changes a client's settings. For now: webhook_url, the default webhook (null or "" clears it). */
exports.Update = async (req, res) => {
    const body = req.body || {};
    const changes = {};
    if (body.webhook_url !== undefined) {
        const url = body.webhook_url === null ? '' : String(body.webhook_url).trim();
        if (url) {
            const problem = webhookHelper.urlProblem(url);
            if (problem) return res.status(400).json({error: problem});
        }
        changes.webhook_url = url || null;
    }
    if (body.trial_until !== undefined) {
        if (body.trial_until === null || body.trial_until === '') {
            changes.trial_until = null;
        } else {
            const until = new Date(body.trial_until);
            if (Number.isNaN(until.getTime())) return res.status(400).json({error: 'invalid_trial_until'});
            changes.trial_until = until;
        }
    }
    if (!Object.keys(changes).length) return res.status(400).json({error: 'nothing_to_update'});
    try {
        const client = await db.client.findByPk(req.params.id);
        if (!client) return res.status(404).json({error: 'client_not_found'});
        await client.update(changes);
        if (changes.webhook_url && !client.webhook_secret) await client.update({webhook_secret: webhookHelper.newSecret()});
        const usage = await usageByClient([client.id]);
        return res.json({client: {...client.toPublic(), ...(usage.get(client.id) || NO_USAGE)}});
    } catch (err) {
        console.error('Client update failed:', err.message);
        return res.status(500).json({error: 'client_update_failed'});
    }
};

exports.Revoke = async (req, res) => {
    try {
        const client = await db.client.findByPk(req.params.id);
        if (!client) return res.status(404).json({error: 'client_not_found'});
        if (client.status !== 'revoked') {
            await client.update({status: 'revoked', revoked_at: new Date()});
        }
        return res.json({client: client.toPublic()});
    } catch (err) {
        console.error('Client revoke failed:', err.message);
        return res.status(500).json({error: 'client_revoke_failed'});
    }
};

/** Adds or takes away paid credits, with a note for the ledger. */
exports.AdjustCredits = async (req, res) => {
    const body = req.body || {};
    const credits = Number(body.credits);
    const note = String(body.note || '').trim();
    if (!Number.isInteger(credits) || credits === 0 || Math.abs(credits) > 1000000) return res.status(400).json({error: 'invalid_credits'});
    if (!note || note.length > 200) return res.status(400).json({error: 'note_required'});
    try {
        const {client} = await billing.adjust(req.params.id, {
            credits, kind: 'adjustment', description: note, adminId: req.admin ? req.admin.id : null,
        });
        const usage = await usageByClient([client.id]);
        return res.json({client: {...client.toPublic(), ...(usage.get(client.id) || NO_USAGE)}});
    } catch (err) {
        if (err.code === 'client_not_found') return res.status(404).json({error: 'client_not_found'});
        if (err.code === 'balance_would_go_negative') return res.status(400).json({error: 'balance_would_go_negative'});
        console.error('Credit adjustment failed:', err.message);
        return res.status(500).json({error: 'adjustment_failed'});
    }
};

exports.Transactions = async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25));
    try {
        const {rows, count} = await db.credit_transaction.findAndCountAll({
            where: {client_id: req.params.id}, order: [['id', 'DESC']], limit: perPage, offset: (page - 1) * perPage,
        });
        return res.json({transactions: rows.map((t) => t.toPublic()), page, per_page: perPage, total: count});
    } catch (err) {
        console.error('Client transactions failed:', err.message);
        return res.status(500).json({error: 'transactions_failed'});
    }
};

exports.Users = async (req, res) => {
    try {
        const users = await db.user.findAll({where: {client_id: req.params.id}, order: [['id', 'ASC']]});
        return res.json({users: users.map((u) => u.toPublic())});
    } catch (err) {
        console.error('Client users failed:', err.message);
        return res.status(500).json({error: 'users_failed'});
    }
};

/** Top-ups: one client's (with :id), or everyone's. */
exports.Topups = async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25));
    const where = {};
    if (req.params.id) where.client_id = req.params.id;
    if (req.query.status) where.status = String(req.query.status);
    try {
        const {rows, count} = await db.topup.findAndCountAll({
            where, include: [{model: db.client, attributes: ['id', 'name']}], order: [['id', 'DESC']], limit: perPage, offset: (page - 1) * perPage,
        });
        return res.json({
            topups: rows.map((t) => ({...t.toPublic(), client_id: t.client_id, client_name: t.client ? t.client.name : null, provider_status: t.provider_status})),
            page, per_page: perPage, total: count,
        });
    } catch (err) {
        console.error('Top-up list failed:', err.message);
        return res.status(500).json({error: 'topups_failed'});
    }
};
