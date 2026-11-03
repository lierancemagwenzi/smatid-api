const tokenHelper = require('../helpers/tokenHelper');
const webhookHelper = require('../helpers/webhookHelper');
const portalAuth = require('../helpers/portalAuthHelper');
const deliveryHelper = require('../helpers/liveness/deliveryHelper');
const topupHelper = require('../helpers/billing/topupHelper');
const mailHelper = require('../helpers/mailHelper');
const usage = require('./UsageController');
const {view} = require('./AccountController');
const db = require('../models');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const page = (q, max = 100) => ({
    page: Math.max(1, Number(q.page) || 1),
    perPage: Math.min(max, Math.max(1, Number(q.per_page) || 25)),
});

const fail = (res, label, err, code) => {
    console.error(`${label} failed:`, err.message);
    return res.status(500).json({error: code});
};

// ----- Dashboard and usage: always only this client's -----

exports.Dashboard = async (req, res) => {
    try {
        const client = await req.portalClient.reload();
        const [stats, recent, modules] = await Promise.all([
            usage.stats({...req.query, client_id: String(client.id)}),
            usage.listRequests({client_id: String(client.id), per_page: 8}),
            db.kyc_module.findAll({order: [['id', 'ASC']]}),
        ]);
        return res.json({
            ...(await view(req.user, client)),
            stats,
            recent: recent.requests,
            prices: modules.map((m) => ({key: m.key, name: m.name, credit_cost: m.credit_cost, status: m.status})),
        });
    } catch (err) {
        return fail(res, 'Portal dashboard', err, 'dashboard_failed');
    }
};

exports.Usage = async (req, res) => {
    try {
        return res.json(await usage.listRequests({...req.query, client_id: String(req.portalClient.id)}));
    } catch (err) {
        return fail(res, 'Portal usage', err, 'usage_failed');
    }
};

exports.UsageDetail = async (req, res) => {
    try {
        const request = await usage.findRequest(req.params.id, req.portalClient.id);
        if (!request) return res.status(404).json({error: 'request_not_found'});
        return res.json({request});
    } catch (err) {
        return fail(res, 'Portal usage detail', err, 'usage_failed');
    }
};

/** Every change to the client's credits, newest first. */
exports.Transactions = async (req, res) => {
    const {page: p, perPage} = page(req.query);
    try {
        const {rows, count} = await db.credit_transaction.findAndCountAll({
            where: {client_id: req.portalClient.id}, order: [['id', 'DESC']], limit: perPage, offset: (p - 1) * perPage,
        });
        return res.json({transactions: rows.map((t) => t.toPublic()), page: p, per_page: perPage, total: count});
    } catch (err) {
        return fail(res, 'Portal transactions', err, 'transactions_failed');
    }
};

// ----- Top-ups -----

exports.TopupOptions = async (req, res) => {
    try {
        return res.json(await topupHelper.options());
    } catch (err) {
        return fail(res, 'Top-up options', err, 'topup_options_failed');
    }
};

exports.Topups = async (req, res) => {
    const {page: p, perPage} = page(req.query, 50);
    try {
        const {rows, count} = await db.topup.findAndCountAll({
            where: {client_id: req.portalClient.id}, order: [['id', 'DESC']], limit: perPage, offset: (p - 1) * perPage,
        });
        return res.json({topups: rows.map((t) => t.toPublic()), page: p, per_page: perPage, total: count});
    } catch (err) {
        return fail(res, 'Portal top-ups', err, 'topups_failed');
    }
};

exports.CreateTopup = async (req, res) => {
    const body = req.body || {};
    try {
        const topup = await topupHelper.create({client: req.portalClient, user: req.user, credits: body.credits, method: body.method, mobile: body.mobile});
        return res.status(201).json({topup: topup.toPublic()});
    } catch (err) {
        if (err instanceof topupHelper.TopupError) {
            const status = err.code === 'payments_unavailable' ? 503 : err.code === 'payment_not_started' ? 502 : 400;
            return res.status(status).json({error: err.code, message: err.code === 'payment_not_started' ? err.message : undefined});
        }
        return fail(res, 'Top-up', err, 'topup_failed');
    }
};

/** One top-up, checked with Smatpay first if it's still waiting. */
exports.Topup = async (req, res) => {
    try {
        const topup = await db.topup.findOne({where: {id: req.params.id, client_id: req.portalClient.id}});
        if (!topup) return res.status(404).json({error: 'topup_not_found'});
        await topupHelper.refresh(topup);
        const client = await req.portalClient.reload();
        return res.json({topup: topup.toPublic(), balance: client.balance()});
    } catch (err) {
        return fail(res, 'Top-up lookup', err, 'topup_failed');
    }
};

// ----- Developers: API token and webhook (owners only) -----

/** Makes a new API token. The old one stops working at once. The token is shown only in this reply. */
exports.CreateApiToken = async (req, res) => {
    try {
        const token = tokenHelper.newToken();
        await req.portalClient.update({token_hash: tokenHelper.sha256(token), token_prefix: tokenHelper.prefixOf(token)});
        return res.status(201).json({access_token: token, token_prefix: req.portalClient.token_prefix});
    } catch (err) {
        return fail(res, 'API token', err, 'token_failed');
    }
};

exports.Developers = async (req, res) => {
    const c = req.portalClient;
    return res.json({has_api_token: Boolean(c.token_hash), token_prefix: c.token_prefix, webhook_url: c.webhook_url || null, has_webhook_secret: Boolean(c.webhook_secret)});
};

exports.SetWebhook = async (req, res) => {
    const value = req.body ? req.body.webhook_url : undefined;
    if (value === undefined) return res.status(400).json({error: 'webhook_url_required'});
    const url = value === null ? '' : String(value).trim();
    if (url) {
        const problem = webhookHelper.urlProblem(url);
        if (problem) return res.status(400).json({error: problem});
    }
    try {
        await req.portalClient.update({webhook_url: url || null});
        if (url) await deliveryHelper.secretFor(req.portalClient);
        return res.json({webhook_url: req.portalClient.webhook_url || null});
    } catch (err) {
        return fail(res, 'Portal webhook', err, 'webhook_update_failed');
    }
};

exports.WebhookSecret = async (req, res) => {
    try {
        return res.json({webhook_secret: await deliveryHelper.secretFor(req.portalClient)});
    } catch (err) {
        return fail(res, 'Portal webhook secret', err, 'webhook_secret_failed');
    }
};

exports.RotateWebhookSecret = async (req, res) => {
    try {
        await req.portalClient.update({webhook_secret: webhookHelper.newSecret()});
        return res.json({webhook_secret: req.portalClient.webhook_secret});
    } catch (err) {
        return fail(res, 'Portal webhook secret', err, 'webhook_secret_failed');
    }
};

// ----- Checks run from the portal -----

const PORTAL_CHECKS = [{check_type: 'company', module: 'companies-check'}, {check_type: 'sanctions', module: 'sanctions-check'}];

/** What each portal check costs and whether it's switched on. */
exports.CheckOptions = async (req, res) => {
    try {
        const mods = await db.kyc_module.findAll({where: {key: PORTAL_CHECKS.map((c) => c.module)}});
        const byKey = new Map(mods.map((m) => [m.key, m]));
        return res.json({
            checks: PORTAL_CHECKS.map((c) => {
                const m = byKey.get(c.module);
                return {check_type: c.check_type, name: m ? m.name : c.check_type, credit_cost: m ? m.credit_cost : 0, enabled: Boolean(m && m.status === 'enabled')};
            }),
        });
    } catch (err) {
        return fail(res, 'Check options', err, 'checks_failed');
    }
};

// ----- Team -----

exports.Team = async (req, res) => {
    try {
        const users = await db.user.findAll({where: {client_id: req.portalClient.id}, order: [['id', 'ASC']]});
        return res.json({users: users.map((u) => u.toPublic())});
    } catch (err) {
        return fail(res, 'Team list', err, 'team_failed');
    }
};

/** Invites someone to the company. They set their own password from the email. */
exports.Invite = async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role === 'owner' ? 'owner' : 'member';
    if (!name || name.length > 255) return res.status(400).json({error: 'name_required'});
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({error: 'valid_email_required'});
    try {
        if (await db.user.findOne({where: {email}})) return res.status(409).json({error: 'email_taken'});
        const user = await db.user.create({client_id: req.portalClient.id, name, email, role});
        const sent = await mailHelper.sendInvite(user, req.user, req.portalClient, await portalAuth.issueLinkToken(user, 'invite'));
        return res.status(201).json({user: user.toPublic(), email_sent: sent});
    } catch (err) {
        return fail(res, 'Invite', err, 'invite_failed');
    }
};

/** Removes someone from the company. Not yourself, and never the last owner. */
exports.RemoveUser = async (req, res) => {
    try {
        const user = await db.user.findOne({where: {id: req.params.id, client_id: req.portalClient.id}});
        if (!user) return res.status(404).json({error: 'user_not_found'});
        if (user.id === req.user.id) return res.status(400).json({error: 'cannot_remove_yourself'});
        if (user.isOwner()) {
            const owners = await db.user.count({where: {client_id: req.portalClient.id, role: 'owner', status: 'active'}});
            if (owners <= 1) return res.status(400).json({error: 'last_owner'});
        }
        await user.destroy();
        return res.json({removed: true});
    } catch (err) {
        return fail(res, 'Remove user', err, 'remove_failed');
    }
};
