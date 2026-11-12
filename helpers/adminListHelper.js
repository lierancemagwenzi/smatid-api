/**
 * The paging and filters the admin scan lists share: `?status=…&client_id=…&page=1&per_page=25`, newest first.
 */
function listQuery(query, {statuses} = {}) {
    const where = {};
    if (query.status && (!statuses || statuses.includes(query.status))) where.status = String(query.status);
    if (/^\d{1,10}$/.test(String(query.client_id || ''))) where.client_id = Number(query.client_id);
    const perPage = Math.min(100, Math.max(1, Number(query.per_page) || 25));
    const page = Math.max(1, Number(query.page) || 1);
    return {where, page, perPage, limit: perPage, offset: (page - 1) * perPage};
}

module.exports = {listQuery};
