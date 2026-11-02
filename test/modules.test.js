const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

async function service(t) {
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, {headers = {}, body} = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {'Content-Type': 'application/json', ...headers},
            body: body && JSON.stringify(body),
        });
        return {status: res.status, body: await res.json()};
    };
}

/** An in-memory modules table. */
function moduleTable(t, rows) {
    const table = rows.map((r, i) => {
        // Free, so these tests are about switching modules, not about credits.
        const m = db.kyc_module.build({id: i + 1, credit_cost: 0, ...r});
        m.update = async (changes) => Object.assign(m, changes);
        return m;
    });
    stub(t, db.kyc_module, {
        findAll: async () => table,
        findOne: async ({where}) => table.find((m) => m.key === where.key) || null,
        findByPk: async (id) => table.find((m) => String(m.id) === String(id)) || null,
        create: async (fields) => {
            const m = db.kyc_module.build({id: table.length + 1, ...fields});
            table.push(m);
            return m;
        },
    });
    return table;
}

function kycClient(t) {
    stub(t, db.client, {findOne: async () => Object.assign(db.client.build({id: 1, name: 'A', status: 'active'}), {update: async () => {}})});
    const logged = [];
    stub(t, db.api_request, {create: async (fields) => logged.push(fields)});
    return {headers: {Authorization: `Bearer ${tokenHelper.newToken()}`}, logged};
}

const admin = {'X-Admin-Key': 'admin-secret'};
function adminKey(t) {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
}

test('a disabled module turns its endpoint off, and the refused call is logged', async (t) => {
    const table = moduleTable(t, [
        {key: 'companies-check', name: 'Company registration', status: 'disabled'},
        {key: 'sanctions-check', name: 'Sanctions', status: 'enabled'},
    ]);
    const {headers, logged} = kycClient(t);
    const call = await service(t);

    assert.deepStrictEqual(await call('GET', '/api/kyc/company/bad%20num', {headers}),
        {status: 403, body: {error: 'module_disabled', module: 'companies-check'}});
    // Sanctions is on: the request gets to the controller, which rejects the empty body.
    assert.strictEqual((await call('POST', '/api/kyc/sanctions', {headers, body: {}})).status, 400);

    table[0].status = 'enabled';
    assert.strictEqual((await call('GET', '/api/kyc/company/bad%20num', {headers})).status, 400);

    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(logged.map((l) => [l.check_type, l.status]), [['company', 403], ['sanctions', 400], ['company', 400]]);
});

test('a module missing from the table counts as disabled', async (t) => {
    moduleTable(t, []);
    const {headers} = kycClient(t);
    const call = await service(t);
    assert.deepStrictEqual(await call('POST', '/api/kyc/sanctions', {headers, body: {}}),
        {status: 403, body: {error: 'module_disabled', module: 'sanctions-check'}});
});

test('the admin lists, creates and switches modules', async (t) => {
    adminKey(t);
    moduleTable(t, [{key: 'sanctions-check', name: 'Sanctions', status: 'enabled'}]);
    const call = await service(t);

    const list = await call('GET', '/api/admin/modules', {headers: admin});
    assert.strictEqual(list.body.modules[0].key, 'sanctions-check');
    assert.strictEqual(list.body.modules[0].connected, true, 'an endpoint checks this key');

    assert.strictEqual((await call('POST', '/api/admin/modules', {headers: admin, body: {key: 'Bad Key', name: 'X'}})).body.error, 'invalid_key');
    assert.strictEqual((await call('POST', '/api/admin/modules', {headers: admin, body: {key: 'passport-check'}})).body.error, 'name_required');
    assert.strictEqual((await call('POST', '/api/admin/modules', {headers: admin, body: {key: 'passport-check', name: 'L', status: 'on'}})).body.error,
        'status_must_be_enabled_or_disabled');
    assert.strictEqual((await call('POST', '/api/admin/modules', {headers: admin, body: {key: 'sanctions-check', name: 'Again'}})).status, 409);

    const created = await call('POST', '/api/admin/modules', {headers: admin, body: {key: 'passport-check', name: ' Passport ', status: 'disabled'}});
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(
        [created.body.module.key, created.body.module.name, created.body.module.status, created.body.module.connected],
        ['passport-check', 'Passport', 'disabled', false],
    );

    const off = await call('PATCH', '/api/admin/modules/1', {headers: admin, body: {status: 'disabled', key: 'renamed'}});
    assert.strictEqual(off.body.module.status, 'disabled');
    assert.strictEqual(off.body.module.key, 'sanctions-check', 'the key never changes');
    assert.strictEqual((await call('PATCH', '/api/admin/modules/99', {headers: admin, body: {status: 'enabled'}})).status, 404);
    assert.strictEqual((await call('PATCH', '/api/admin/modules/1', {headers: admin, body: {name: ''}})).body.error, 'name_required');
});

test('module admin needs an admin', async (t) => {
    const call = await service(t);
    assert.strictEqual((await call('GET', '/api/admin/modules')).status, 401);
    assert.strictEqual((await call('PATCH', '/api/admin/modules/1', {body: {status: 'disabled'}})).status, 401);
});
