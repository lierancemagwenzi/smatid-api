const moduleHelper = require('../helpers/moduleHelper');
const db = require('../models');

const withConnection = (m) => ({...m.toPublic(), connected: moduleHelper.isConnected(m.key)});

/** name, description and status from a body, checked. Only the fields given are returned. */
function editable(body) {
    const out = {};
    if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name || name.length > 255) return {error: 'name_required'};
        out.name = name;
    }
    if (body.description !== undefined) {
        out.description = body.description === null ? null : String(body.description).trim().slice(0, 2000) || null;
    }
    if (body.status !== undefined) {
        if (!moduleHelper.STATUSES.includes(body.status)) return {error: 'status_must_be_enabled_or_disabled'};
        out.status = body.status;
    }
    if (body.credit_cost !== undefined) {
        const cost = Number(body.credit_cost);
        if (!Number.isInteger(cost) || cost < 0 || cost > 1000) return {error: 'invalid_credit_cost'};
        out.credit_cost = cost;
    }
    return {fields: out};
}

exports.List = async (req, res) => {
    try {
        const modules = await db.kyc_module.findAll({order: [['id', 'ASC']]});
        return res.json({modules: modules.map(withConnection)});
    } catch (err) {
        console.error('Module list failed:', err.message);
        return res.status(500).json({error: 'module_list_failed'});
    }
};

exports.Create = async (req, res) => {
    const body = req.body || {};
    const key = String(body.key || '').trim().toLowerCase();
    if (!moduleHelper.KEY_PATTERN.test(key) || key.length > 64) return res.status(400).json({error: 'invalid_key'});
    if (body.name === undefined) return res.status(400).json({error: 'name_required'});
    const {error, fields} = editable({status: 'enabled', ...body});
    if (error) return res.status(400).json({error});

    try {
        if (await db.kyc_module.findOne({where: {key}})) return res.status(409).json({error: 'key_taken'});
        const created = await db.kyc_module.create({key, ...fields});
        return res.status(201).json({module: withConnection(created)});
    } catch (err) {
        console.error('Module create failed:', err.message);
        return res.status(500).json({error: 'module_create_failed'});
    }
};

// The key can't be changed: the code refers to it.
exports.Update = async (req, res) => {
    const {error, fields} = editable(req.body || {});
    if (error) return res.status(400).json({error});
    try {
        const found = await db.kyc_module.findByPk(req.params.id);
        if (!found) return res.status(404).json({error: 'module_not_found'});
        if (Object.keys(fields).length) await found.update(fields);
        return res.json({module: withConnection(found)});
    } catch (err) {
        console.error('Module update failed:', err.message);
        return res.status(500).json({error: 'module_update_failed'});
    }
};
