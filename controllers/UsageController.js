const usageHelper = require('../helpers/usageHelper');
const db = require('../models');

const {Op, fn, col, literal, where, cast} = db.Sequelize;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** from/to as YYYY-MM-DD (UTC, both days included). Defaults to the last `days` days. */
function dateRange(query, days) {
    const to = DATE_PATTERN.test(query.to || '') ? new Date(`${query.to}T00:00:00Z`) : null;
    const from = DATE_PATTERN.test(query.from || '') ? new Date(`${query.from}T00:00:00Z`) : null;
    const end = to ? new Date(to.getTime() + 86400000) : null;
    const start = from || (days ? new Date(Date.now() - days * 86400000) : null);
    const range = {};
    if (start) range[Op.gte] = start;
    if (end) range[Op.lt] = end;
    return {range, start, end};
}

/** The filters the usage list and stats share. */
function filters(query, days) {
    const conditions = [];
    const {range, start, end} = dateRange(query, days);
    if (start || end) conditions.push({createdAt: range});
    if (/^\d+$/.test(query.client_id || '')) conditions.push({client_id: Number(query.client_id)});
    if (query.check_type) conditions.push({check_type: String(query.check_type)});
    if (query.outcome === 'error') conditions.push({status: {[Op.gte]: 400, [Op.ne]: 404}});
    if (query.outcome === 'ok') conditions.push({status: {[Op.or]: [{[Op.lt]: 400}, 404]}});
    if (query.q) {
        // Searches the stored request: a company number, a name, an ID number...
        conditions.push(where(cast(col('api_request.request'), 'CHAR'), {[Op.like]: `%${String(query.q).slice(0, 100)}%`}));
    }
    return {where: {[Op.and]: conditions}, start, end};
}

exports.List = async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25));
    try {
        const {where: conditions} = filters(req.query);
        const {rows, count} = await db.api_request.findAndCountAll({
            where: conditions,
            include: [{model: db.client, attributes: ['id', 'name']}],
            order: [['id', 'DESC']],
            limit: perPage,
            offset: (page - 1) * perPage,
        });
        return res.json({
            requests: rows.map((r) => usageHelper.listItem(r)),
            page,
            per_page: perPage,
            total: count,
        });
    } catch (err) {
        console.error('Usage list failed:', err.message);
        return res.status(500).json({error: 'usage_list_failed'});
    }
};

exports.Show = async (req, res) => {
    try {
        const row = await db.api_request.findByPk(req.params.id, {
            include: [{model: db.client, attributes: ['id', 'name']}],
        });
        if (!row) return res.status(404).json({error: 'request_not_found'});
        return res.json({request: usageHelper.detail(row)});
    } catch (err) {
        console.error('Usage detail failed:', err.message);
        return res.status(500).json({error: 'usage_detail_failed'});
    }
};

/** Counts for the dashboard: totals, per check, per day and per client. Defaults to the last 30 days. */
exports.Stats = async (req, res) => {
    try {
        const {where: conditions, start, end} = filters(req.query, 30);
        const isError = literal('CASE WHEN status >= 400 AND status <> 404 THEN 1 ELSE 0 END');
        const byCheck = await db.api_request.findAll({
            where: conditions,
            attributes: ['check_type', [fn('COUNT', col('id')), 'requests'], [fn('SUM', isError), 'errors']],
            group: ['check_type'],
            raw: true,
        });
        const byDay = await db.api_request.findAll({
            where: conditions,
            attributes: [[fn('DATE', col('created_at')), 'date'], 'check_type', [fn('COUNT', col('id')), 'requests']],
            group: [fn('DATE', col('created_at')), 'check_type'],
            order: [[fn('DATE', col('created_at')), 'ASC']],
            raw: true,
        });
        const byClient = await db.api_request.findAll({
            where: conditions,
            attributes: ['client_id', [fn('COUNT', col('api_request.id')), 'requests']],
            include: [{model: db.client, attributes: ['name']}],
            group: ['client_id', 'client.id'],
            order: [[literal('requests'), 'DESC']],
            limit: 10,
            raw: true,
        });
        const clients = await db.client.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            group: ['status'],
            raw: true,
        });

        const checks = byCheck.map((r) => ({check_type: r.check_type, requests: Number(r.requests), errors: Number(r.errors)}));
        const clientCounts = Object.fromEntries(clients.map((r) => [r.status, Number(r.count)]));
        return res.json({
            from: start,
            to: end,
            totals: {
                requests: checks.reduce((n, c) => n + c.requests, 0),
                errors: checks.reduce((n, c) => n + c.errors, 0),
                active_clients: clientCounts.active || 0,
                revoked_clients: clientCounts.revoked || 0,
            },
            by_check: checks,
            by_day: byDay.map((r) => ({
                date: typeof r.date === 'string' ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10),
                check_type: r.check_type,
                requests: Number(r.requests),
            })),
            by_client: byClient.map((r) => ({client_id: r.client_id, name: r['client.name'], requests: Number(r.requests)})),
        });
    } catch (err) {
        console.error('Usage stats failed:', err.message);
        return res.status(500).json({error: 'usage_stats_failed'});
    }
};
