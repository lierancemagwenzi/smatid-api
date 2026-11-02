const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const passwordHelper = require('../helpers/passwordHelper');
const usageHelper = require('../helpers/usageHelper');
const admin = require('../controllers/AdminController');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

async function service(t) {
    const app = express();
    app.use(require('../helpers/corsHelper').allowOrigins());
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
        const text = await res.text();
        return {status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers};
    };
}

/** One admin "Ada" with password "correct horse", and an in-memory sessions table. */
async function adminFixture(t) {
    admin.resetFailures();
    const ada = db.admin.build({id: 3, name: 'Ada', email: 'ada@smatid.com', password_hash: await passwordHelper.hash('correct horse')});
    ada.update = async (changes) => Object.assign(ada, changes);
    const sessions = [];
    stub(t, db.admin, {findOne: async ({where}) => (where.email === ada.email ? ada : null)});
    stub(t, db.admin_session, {
        create: async (fields) => {
            const s = db.admin_session.build(fields);
            s.destroy = async () => sessions.splice(sessions.indexOf(s), 1);
            sessions.push(s);
            return s;
        },
        findOne: async ({where}) => {
            const s = sessions.find((x) => x.token_hash === where.token_hash);
            return s ? Object.assign(s, {admin: ada}) : null;
        },
        destroy: async () => 0,
    });
    return {ada, sessions};
}

test('passwords are hashed with a salt and checked', async () => {
    const a = await passwordHelper.hash('correct horse');
    assert.match(a, /^scrypt\$[\w-]+\$[\w-]+$/);
    assert.notStrictEqual(a, await passwordHelper.hash('correct horse'));
    assert.strictEqual(await passwordHelper.verify('correct horse', a), true);
    assert.strictEqual(await passwordHelper.verify('wrong', a), false);
    assert.strictEqual(await passwordHelper.verify('x', 'garbage'), false);
});

test('an admin signs in, uses the session, and signs out', async (t) => {
    const {ada, sessions} = await adminFixture(t);
    const call = await service(t);

    assert.strictEqual((await call('POST', '/api/admin/login', {body: {email: 'ada@smatid.com'}})).status, 400);
    assert.deepStrictEqual((await call('POST', '/api/admin/login', {body: {email: 'ada@smatid.com', password: 'nope'}})).body,
        {error: 'invalid_credentials'});
    assert.deepStrictEqual((await call('POST', '/api/admin/login', {body: {email: 'who@smatid.com', password: 'correct horse'}})).body,
        {error: 'invalid_credentials'});

    const login = await call('POST', '/api/admin/login', {body: {email: ' ADA@smatid.com ', password: 'correct horse'}});
    assert.strictEqual(login.status, 200);
    assert.match(login.body.token, /^adm_/);
    assert.deepStrictEqual(Object.keys(login.body.admin).sort(), ['email', 'id', 'last_login_at', 'name']);
    assert.ok(ada.last_login_at);
    assert.strictEqual(sessions[0].token_hash, tokenHelper.sha256(login.body.token), 'only the hash is kept');

    const auth = {Authorization: `Bearer ${login.body.token}`};
    const me = await call('GET', '/api/admin/me', {headers: auth});
    assert.strictEqual(me.body.admin.email, 'ada@smatid.com');
    assert.strictEqual(me.body.via, 'session');

    assert.strictEqual((await call('POST', '/api/admin/logout', {headers: auth})).status, 200);
    assert.strictEqual(sessions.length, 0);
    assert.strictEqual((await call('GET', '/api/admin/me', {headers: auth})).status, 401);
});

test('an expired session is refused', async (t) => {
    const {sessions} = await adminFixture(t);
    const token = tokenHelper.newSessionToken();
    await db.admin_session.create({admin_id: 3, token_hash: tokenHelper.sha256(token), expires_at: new Date(Date.now() - 1000)});
    const call = await service(t);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual((await call('GET', '/api/admin/me', {headers: {Authorization: `Bearer ${token}`}})).status, 401);
});

test('too many wrong passwords from one address are turned away', async (t) => {
    await adminFixture(t);
    const call = await service(t);
    for (let i = 0; i < 10; i++) {
        assert.strictEqual((await call('POST', '/api/admin/login', {body: {email: 'ada@smatid.com', password: 'nope'}})).status, 401);
    }
    assert.deepStrictEqual((await call('POST', '/api/admin/login', {body: {email: 'ada@smatid.com', password: 'correct horse'}})).body,
        {error: 'too_many_attempts'});
});

test('CORS answers only the origins in CORS_ORIGINS', async (t) => {
    process.env.CORS_ORIGINS = 'https://kyc.smatid.com, http://localhost:5173';
    t.after(() => delete process.env.CORS_ORIGINS);
    const call = await service(t);

    const ok = await call('OPTIONS', '/api/admin/login', {headers: {Origin: 'https://kyc.smatid.com'}});
    assert.strictEqual(ok.status, 204);
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://kyc.smatid.com');
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);

    const other = await call('GET', '/health', {headers: {Origin: 'https://evil.example'}});
    assert.strictEqual(other.headers.get('access-control-allow-origin'), null);
});

test('usage rows say what was searched for and how it came out', () => {
    const company = (status, response) => ({check_type: 'company', status, request: {params: {number: '38043A0242025'}}, response});
    const sanctions = (status, response) => ({check_type: 'sanctions', status, request: {body: {type: 'person', first_name: 'Vladimir', last_name: 'Putin'}}, response});

    assert.strictEqual(usageHelper.subject(company(200, {})), '38043A0242025');
    assert.strictEqual(usageHelper.subject(sanctions(200, {})), 'Vladimir Putin');
    assert.deepStrictEqual(usageHelper.result(company(200, {found: true, name: 'EXPRESS SMATPAY', status: 'Verified'})),
        {outcome: 'found', label: 'EXPRESS SMATPAY · Verified'});
    assert.strictEqual(usageHelper.result(company(404, {found: false})).outcome, 'not_found');
    assert.deepStrictEqual(usageHelper.result(company(502, {error: 'registry_unavailable'})),
        {outcome: 'error', label: 'registry_unavailable'});
    assert.strictEqual(usageHelper.result(sanctions(200, {hit: false})).outcome, 'clear');
    assert.deepStrictEqual(usageHelper.result(sanctions(200, {hit: true, sanctioned: true, matches: [{name: 'Vladimir Putin', score: 1}]})),
        {outcome: 'sanctioned', label: 'Sanctioned: Vladimir Putin (100%)'});
    assert.strictEqual(usageHelper.result(sanctions(200, {hit: true, pep: true, matches: [{name: 'X', score: 0.9}]})).outcome, 'pep');
});

test('liveness rows say whose check it was and how it ended', () => {
    const row = (status, response, request = {body: {reference: 'cust-42'}}) => ({check_type: 'liveness', status, request, response});
    assert.strictEqual(usageHelper.subject(row(201, {session_id: 'lv_x'})), 'cust-42');
    assert.strictEqual(usageHelper.subject(row(200, {session_id: 'lv_x'}, {params: {sessionId: 'lv_x'}})), 'lv_x');
    assert.strictEqual(usageHelper.result(row(201, {status: 'pending'})).label, 'Session opened');
    assert.strictEqual(usageHelper.result(row(200, {status: 'passed'})).outcome, 'passed');
    assert.deepStrictEqual(usageHelper.result(row(200, {status: 'failed', failure_reason: 'spoof_suspected'})),
        {outcome: 'failed', label: 'Failed: spoof_suspected'});
    assert.strictEqual(usageHelper.result(row(200, {status: 'expired'})).outcome, 'expired');
    assert.strictEqual(usageHelper.result(row(403, {error: 'module_disabled'})).outcome, 'error');
    assert.strictEqual(usageHelper.detail(row(200, {session_id: 'lv_x', status: 'passed'})).liveness_session_id, 'lv_x');
});
