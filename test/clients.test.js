const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const mailHelper = require('../helpers/mailHelper');

/** Swaps model methods for stand-ins for the length of one test. */
function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

/** A client row without a database; update() just applies the change. */
function row(fields) {
    const c = db.client.build({
        id: 1, name: 'Acme', token_hash: 'h', token_prefix: 'kyc_abcdefgh', createdAt: new Date(), ...fields,
    });
    c.update = async (changes) => Object.assign(c, changes);
    return c;
}

/** Every module enabled, for tests that aren't about modules. */
function modulesOn(t) {
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled'})});
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

test('tokens look like kyc_ + 43 characters and are never the same', () => {
    const a = tokenHelper.newToken();
    assert.match(a, /^kyc_[A-Za-z0-9_-]{43}$/);
    assert.notStrictEqual(a, tokenHelper.newToken());
    assert.strictEqual(tokenHelper.prefixOf(a), a.slice(0, 12));
});

test('KYC calls need an active client token', async (t) => {
    const good = tokenHelper.newToken();
    const revoked = tokenHelper.newToken();
    const lookups = [];
    stub(t, db.client, {
        findOne: async ({where}) => {
            lookups.push(where.token_hash);
            if (where.token_hash === tokenHelper.sha256(good)) return row({});
            if (where.token_hash === tokenHelper.sha256(revoked)) return row({status: 'revoked'});
            return null;
        },
    });
    stub(t, db.api_request, {create: async () => {}});
    modulesOn(t);
    const call = await service(t);

    assert.deepStrictEqual(await call('GET', '/api/kyc/company/bad%20num'),
        {status: 401, body: {error: 'missing_access_token'}});
    assert.deepStrictEqual(await call('GET', '/api/kyc/company/bad%20num', {headers: {Authorization: 'Bearer kyc_nope'}}),
        {status: 401, body: {error: 'invalid_access_token'}});
    assert.deepStrictEqual(await call('GET', '/api/kyc/company/bad%20num', {headers: {Authorization: `Bearer ${revoked}`}}),
        {status: 401, body: {error: 'invalid_access_token'}});

    // Gets past auth to the controller, which rejects the number.
    assert.deepStrictEqual(await call('GET', '/api/kyc/company/bad%20num', {headers: {Authorization: `Bearer ${good}`}}),
        {status: 400, body: {error: 'invalid_registration_number'}});

    assert.ok(!lookups.includes(good), 'looked up by hash, never by the raw token');
});

test('X-Admin-Key works only when ADMIN_API_KEY is set, and must match', async (t) => {
    stub(t, db.client, {findAll: async () => []});
    stub(t, db.api_request, {findAll: async () => []});
    const call = await service(t);
    delete process.env.ADMIN_API_KEY;
    assert.strictEqual((await call('GET', '/api/admin/clients')).status, 401);
    assert.deepStrictEqual(await call('GET', '/api/admin/clients', {headers: {'X-Admin-Key': 'anything'}}),
        {status: 503, body: {error: 'admin_key_disabled'}});

    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    assert.strictEqual((await call('GET', '/api/admin/clients', {headers: {'X-Admin-Key': 'wrong'}})).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/clients', {headers: {'X-Admin-Key': 'admin-secret'}})).status, 200);
});

/** Admin key and SendGrid key for one test; SendGrid itself replaced by `send`. */
function adminWithMail(t, send) {
    process.env.ADMIN_API_KEY = 'admin-secret';
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.MAIL_FROM_EMAIL = 'no-reply@example.com';
    t.after(() => {
        delete process.env.ADMIN_API_KEY;
        delete process.env.SENDGRID_API_KEY;
        delete process.env.MAIL_FROM_EMAIL;
    });
    stub(t, mailHelper.sgMail, {send});
    return {'X-Admin-Key': 'admin-secret'};
}

test('creating a client returns its token once, stores only the hash and emails the token', async (t) => {
    const sent = [];
    const admin = adminWithMail(t, async (msg) => (sent.push(msg), [{statusCode: 202}]));
    let stored;
    stub(t, db.client, {create: async (fields) => (stored = row(fields))});
    const call = await service(t);

    assert.deepStrictEqual(await call('POST', '/api/admin/clients', {headers: admin, body: {}}),
        {status: 400, body: {error: 'name_required'}});
    assert.deepStrictEqual(await call('POST', '/api/admin/clients', {headers: admin, body: {name: 'A'}}),
        {status: 400, body: {error: 'valid_email_required'}});
    assert.deepStrictEqual(await call('POST', '/api/admin/clients', {headers: admin, body: {name: 'A', email: 'nope'}}),
        {status: 400, body: {error: 'valid_email_required'}});
    assert.strictEqual(sent.length, 0, 'nothing is emailed for a rejected request');

    const res = await call('POST', '/api/admin/clients', {headers: admin, body: {name: ' Acme <Bank> ', email: 'it@acme.co.zw'}});
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.email_sent, true);
    const token = res.body.access_token;

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'it@acme.co.zw');
    assert.strictEqual(sent[0].from.email, 'no-reply@example.com');
    assert.ok(sent[0].text.includes(token) && sent[0].html.includes(token), 'the token is in the email');
    assert.ok(sent[0].html.includes('Acme &lt;Bank&gt;') && !sent[0].html.includes('<Bank>'), 'the name is escaped');
    assert.strictEqual(sent[0].trackingSettings.clickTracking.enable, false);
    assert.match(token, /^kyc_/);
    assert.strictEqual(stored.token_hash, tokenHelper.sha256(token));
    assert.strictEqual(stored.name, 'Acme <Bank>');
    assert.strictEqual(res.body.client.token_prefix, token.slice(0, 12));
    assert.strictEqual(res.body.client.token_hash, undefined);
    assert.ok(res.body.client.created_at, 'created_at is shown');
    assert.ok(!JSON.stringify(res.body.client).includes(token));
});

test('a failed email still creates the client and hands the admin the token', async (t) => {
    const admin = adminWithMail(t, async () => {
        throw Object.assign(new Error('Forbidden'), {response: {body: {errors: [{message: 'sender not verified'}]}}});
    });
    stub(t, db.client, {create: async (fields) => row(fields)});
    const call = await service(t);

    const res = await call('POST', '/api/admin/clients', {headers: admin, body: {name: 'Acme', email: 'it@acme.co.zw'}});
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.email_sent, false);
    assert.match(res.body.access_token, /^kyc_/);
});

test('revoking a client', async (t) => {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    const existing = row({});
    stub(t, db.client, {findByPk: async (id) => (String(id) === '1' ? existing : null)});
    const call = await service(t);
    const admin = {'X-Admin-Key': 'admin-secret'};

    assert.strictEqual((await call('POST', '/api/admin/clients/9/revoke', {headers: admin})).status, 404);
    const res = await call('POST', '/api/admin/clients/1/revoke', {headers: admin});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.client.status, 'revoked');
    assert.ok(res.body.client.revoked_at);
});

test('each KYC call is logged with its client, search, response and time', async (t) => {
    const token = tokenHelper.newToken();
    stub(t, db.client, {findOne: async () => row({id: 7})});
    const logged = [];
    let written;
    const done = new Promise((r) => (written = r));
    stub(t, db.api_request, {create: async (fields) => (logged.push(fields), written())});
    modulesOn(t);
    const call = await service(t);

    const res = await call('GET', '/api/kyc/company/bad%20num?ref=abc', {headers: {Authorization: `Bearer ${token}`}});
    assert.strictEqual(res.status, 400);
    await done;

    assert.strictEqual(logged.length, 1);
    const [entry] = logged;
    assert.strictEqual(entry.client_id, 7);
    assert.strictEqual(entry.check_type, 'company');
    assert.strictEqual(entry.method, 'GET');
    assert.strictEqual(entry.path, '/api/kyc/company/bad%20num?ref=abc');
    assert.deepStrictEqual(entry.request, {params: {number: 'bad num'}, query: {ref: 'abc'}});
    assert.strictEqual(entry.status, 400);
    assert.deepStrictEqual(entry.response, {error: 'invalid_registration_number'});
    assert.ok(Number.isInteger(entry.duration_ms) && entry.duration_ms >= 0);
});

test('a call without a valid token is not logged, and a failed log write does not affect the reply', async (t) => {
    stub(t, db.client, {findOne: async () => row({})});
    let attempts = 0;
    stub(t, db.api_request, {create: async () => (attempts++, Promise.reject(new Error('db down')))});
    modulesOn(t);
    const call = await service(t);

    assert.strictEqual((await call('GET', '/api/kyc/company/bad%20num')).status, 401);
    assert.strictEqual(attempts, 0);

    const res = await call('GET', '/api/kyc/company/bad%20num', {headers: {Authorization: 'Bearer kyc_x'}});
    assert.deepStrictEqual(res, {status: 400, body: {error: 'invalid_registration_number'}});
});
