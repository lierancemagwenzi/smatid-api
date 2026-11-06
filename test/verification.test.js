const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const mrzHelper = require('../helpers/passport/mrzHelper');
const verificationHelper = require('../helpers/verification/verificationHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

/** A valid passport MRZ. */
function mrz() {
    const cd = mrzHelper.checkDigit;
    const pad = (s, n) => (s + '<'.repeat(n)).slice(0, n);
    const num = 'FN1234567', b = '900312', e = '310101', opt = '<'.repeat(14);
    const comp = `${num}${cd(num)}${b}${cd(b)}${e}${cd(e)}${opt}<`;
    return [pad('P<ZWEMOYO<<TARIRO', 44), `${num}${cd(num)}ZWE${b}${cd(b)}F${e}${cd(e)}${opt}<${cd(comp)}`];
}
const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]).toString('base64');

/** In-memory tables for clients, sessions, scans and liveness checks. */
function tables(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-'));
    process.env.PASSPORT_STORAGE_DIR = dir;
    t.after(() => {
        delete process.env.PASSPORT_STORAGE_DIR;
        fs.rmSync(dir, {recursive: true, force: true});
    });
    const clients = {
        1: Object.assign(db.client.build({id: 1, name: 'Acme Wallet', status: 'active'}), {update: async () => {}}),
        2: Object.assign(db.client.build({id: 2, name: 'Other', status: 'active'}), {update: async () => {}}),
    };
    const sessions = [];
    const scans = [];
    const lives = [];
    const attach = (row) => Object.assign(row, {update: async (c) => Object.assign(row, c)});
    const match = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
    stub(t, db.client, {findOne: async ({where}) => (where.token_hash === tokenHelper.sha256('kyc_other') ? clients[2] : clients[1])});
    stub(t, db.verification_session, {
        create: async (f) => {
            if (sessions.some((s) => s.code === f.code)) throw Object.assign(new Error('dup'), {name: 'SequelizeUniqueConstraintError'});
            const s = attach(db.verification_session.build({id: sessions.length + 1, ...f, createdAt: new Date()}));
            s.client = clients[f.client_id];
            sessions.push(s);
            return s;
        },
        findOne: async ({where}) => sessions.find((s) => match(s, where)) || null,
    });
    stub(t, db.passport_scan, {
        create: async (f) => {
            const s = attach(db.passport_scan.build({id: scans.length + 1, ...f, createdAt: new Date()}));
            scans.push(s);
            return s;
        },
        findOne: async ({where}) => scans.find((s) => match(s, where)) || null,
    });
    stub(t, db.liveness_session, {
        create: async (f) => {
            const s = attach(db.liveness_session.build({id: lives.length + 1, ...f, createdAt: new Date()}));
            s.client = clients[f.client_id];
            lives.push(s);
            return s;
        },
        findOne: async ({where}) => lives.find((s) => match(s, where)) || null,
    });
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    const logged = [];
    stub(t, db.api_request, {create: async (r) => logged.push(r)});
    return {sessions, scans, lives, logged};
}

async function service(t) {
    const app = express();
    app.use('/api/verify', express.json({limit: '4mb'}));
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, p, {token, body} = {}) => {
        const headers = {'Content-Type': 'application/json'};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(base + p, {method, headers, body: body && JSON.stringify(body)});
        return {status: res.status, body: await res.json()};
    };
}

test('a client opens a session; the app opens it by link or code, without a token', async (t) => {
    const {sessions} = tables(t);
    const call = await service(t);

    assert.strictEqual((await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'selfie'}})).body.error, 'invalid_type');
    assert.strictEqual((await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'full', return_url: 'javascript:alert(1)'}})).body.error, 'invalid_return_url');
    assert.strictEqual((await call('POST', '/api/kyc/verifications', {body: {type: 'full'}})).status, 401, 'the client needs its token');

    const made = await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'full', reference: 'cust-9', return_url: 'acmewallet://kyc/done'}});
    assert.strictEqual(made.status, 201);
    const v = made.body;
    assert.match(v.verification_id, /^vs_[A-Za-z0-9_-]{32}$/);
    assert.match(v.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.strictEqual(v.app_link, `smatid-verify://verify?id=${v.verification_id}`);
    assert.deepStrictEqual(v.steps, {passport: 'not_done', chip: 'not_done', liveness: 'not_done', face_match: 'not_done'});
    assert.strictEqual(v.status, 'pending');

    // By code (any case, with or without the dash), as the person would type it.
    const claimed = await call('POST', '/api/verify/claim', {body: {code: v.code.toLowerCase().replace('-', ' ')}});
    assert.strictEqual(claimed.body.verification_id, v.verification_id);
    assert.strictEqual((await call('POST', '/api/verify/claim', {body: {code: 'ZZZZ-ZZZZ'}})).status, 404);

    const opened = await call('GET', `/api/verify/${v.verification_id}`);
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(opened.body.client_name, 'Acme Wallet');
    assert.deepStrictEqual(opened.body.steps, ['passport', 'chip', 'liveness', 'face_match']);
    assert.strictEqual(sessions[0].status, 'in_progress');
    assert.ok(!('passport' in opened.body), 'the app gets no personal results');

    // Another client can't read it.
    assert.strictEqual((await call('GET', `/api/kyc/verifications/${v.verification_id}`, {token: 'kyc_other'})).status, 404);
});

test('the app runs the session type’s steps, charged to the client; others are refused', async (t) => {
    const {scans, logged} = tables(t);
    const call = await service(t);
    const v = (await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'passport', reference: 'cust-9'}})).body;
    const id = v.verification_id;

    // A liveness check isn't part of a passport session.
    const refused = await call('POST', `/api/verify/${id}/liveness`, {body: {}});
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.error, 'step_not_in_session');

    const scan = await call('POST', `/api/verify/${id}/passport`, {body: {mrz: mrz(), image, reference: 'spoofed', webhook_url: 'https://evil.example'}});
    assert.strictEqual(scan.status, 201, JSON.stringify(scan.body));
    assert.strictEqual(scan.body.reference, 'cust-9', 'the session sets the reference, not the app');
    assert.strictEqual(scans[0].client_id, 1, 'the scan is the client’s');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(logged.some((r) => r.client_id === 1 && r.check_type === 'passport'), 'logged (and charged) to the client');

    // The app can only touch its own scan.
    assert.strictEqual((await call('GET', `/api/verify/${id}/passport/ps_${'x'.repeat(32)}/chip/photo`)).status, 404);

    const done = await call('POST', `/api/verify/${id}/complete`, {body: {}});
    assert.strictEqual(done.body.outcome, 'verified');
    assert.strictEqual(done.body.return_url, null);

    // Closed now: no more checks through it.
    assert.strictEqual((await call('POST', `/api/verify/${id}/passport`, {body: {mrz: mrz(), image}})).body.error, 'verification_closed');

    // The client reads the result, with the scan.
    const result = (await call('GET', `/api/kyc/verifications/${id}`, {token: 'kyc_mine'})).body;
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.outcome, 'verified');
    assert.strictEqual(result.passport.document.document_number, 'FN1234567');
});

test('a skipped chip makes the outcome review; a cancelled session sends the person back', async (t) => {
    tables(t);
    const call = await service(t);
    const v = (await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'passport_chip', return_url: 'acmewallet://kyc/done'}})).body;
    await call('POST', `/api/verify/${v.verification_id}/passport`, {body: {mrz: mrz(), image}});
    const done = await call('POST', `/api/verify/${v.verification_id}/complete`, {body: {skipped: {chip: 'no_nfc', passport: 'nope'}}});
    assert.strictEqual(done.body.outcome, 'review');
    assert.deepStrictEqual(done.body.steps, {passport: 'passed', chip: 'skipped'});
    assert.strictEqual(done.body.return_url, `acmewallet://kyc/done?verification_id=${v.verification_id}&status=completed`);

    const w = (await call('POST', '/api/kyc/verifications', {token: 'kyc_mine', body: {type: 'liveness', return_url: 'acmewallet://kyc/done'}})).body;
    const cancelled = await call('POST', `/api/verify/${w.verification_id}/cancel`, {body: {}});
    assert.strictEqual(cancelled.body.status, 'cancelled');
    assert.match(cancelled.body.return_url, /status=cancelled/);
    // A cancelled session's code no longer opens it.
    assert.strictEqual((await call('POST', '/api/verify/claim', {body: {code: w.code}})).status, 404);
});

test('outcomes add up from the steps', () => {
    assert.strictEqual(verificationHelper.outcomeOf({passport: 'passed', chip: 'passed', liveness: 'passed', face_match: 'passed'}), 'verified');
    assert.strictEqual(verificationHelper.outcomeOf({passport: 'passed', chip: 'passed', liveness: 'passed', face_match: 'review'}), 'review');
    assert.strictEqual(verificationHelper.outcomeOf({passport: 'passed', liveness: 'failed'}), 'failed');
    assert.strictEqual(verificationHelper.outcomeOf({passport: 'passed', liveness: 'not_done'}), 'incomplete');
    assert.strictEqual(verificationHelper.normaliseCode(' ab2c-d3fg '), 'AB2CD3FG');
});
