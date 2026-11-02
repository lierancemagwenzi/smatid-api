const tokenHelper = require('../helpers/tokenHelper');
const mailHelper = require('../helpers/mailHelper');
const db = require('../models');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.Create = async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim() || null;
    if (!name || name.length > 255) return res.status(400).json({error: 'name_required'});
    // The token is emailed to the client, so an address is needed.
    if (!email || !EMAIL_PATTERN.test(email)) return res.status(400).json({error: 'valid_email_required'});

    try {
        const token = tokenHelper.newToken();
        const client = await db.client.create({
            name,
            email,
            token_hash: tokenHelper.sha256(token),
            token_prefix: tokenHelper.prefixOf(token),
        });
        // A failed email doesn't undo the client: the admin still gets the token here and can pass it on.
        const emailSent = await mailHelper.sendAccessToken(client, token);
        // The only time the token is ever shown.
        return res.status(201).json({client: client.toPublic(), access_token: token, email_sent: emailSent});
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
