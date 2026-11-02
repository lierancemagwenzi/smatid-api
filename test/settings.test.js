require('dotenv').config({quiet: true});
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const db = require('../models');
const settings = require('../helpers/settingsHelper');
const smatpay = require('../helpers/payments/smatpayHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

function withKey(t, key = crypto.randomBytes(32).toString('base64')) {
    const before = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = key;
    t.after(() => (before === undefined ? delete process.env.SETTINGS_ENCRYPTION_KEY : (process.env.SETTINGS_ENCRYPTION_KEY = before)));
}

test.after(() => db.sequelize.close());

test('secret settings are stored encrypted and read back', async (t) => {
    try {
        await db.setting.count();
    } catch {
        return t.skip('no database');
    }
    withKey(t);
    const key = `test.${Date.now()}.secret`;
    const plain = `test.${Date.now()}.plain`;
    t.after(() => db.setting.destroy({where: {key: [key, plain]}}).then(() => settings.forget()));

    await settings.set({[key]: 'sk_live_very_secret', [plain]: 'hello'}, {secret: [key]});
    const row = await db.setting.findByPk(key);
    assert.match(row.value, /^enc:/);
    assert.ok(!row.value.includes('very_secret'), 'not stored in the clear');
    assert.strictEqual((await db.setting.findByPk(plain)).value, 'hello');
    assert.strictEqual(await settings.get(key), 'sk_live_very_secret');
    assert.strictEqual(await settings.get(plain), 'hello');

    await settings.set({[key]: null});
    assert.strictEqual(await settings.get(key), null);
});

test('without SETTINGS_ENCRYPTION_KEY, secrets are refused', async (t) => {
    withKey(t, '');
    await assert.rejects(settings.set({'test.x': 'v'}, {secret: ['test.x']}), (err) => err.code === 'encryption_key_missing');
});

// ----- The admin endpoints, with an in-memory settings store -----

function memorySettings(t) {
    const store = new Map();
    stub(t, settings, {
        get: async (k) => store.get(k) ?? null,
        set: async (values, {secret = []} = {}) => {
            if (secret.some((k) => values[k]) && !settings.encryptionReady()) throw Object.assign(new Error('x'), {code: 'encryption_key_missing'});
            for (const [k, v] of Object.entries(values)) (v === null || v === '' ? store.delete(k) : store.set(k, v));
        },
        updatedAt: async () => null,
    });
    return store;
}

function noEnv(t) {
    const names = ['SMATPAY_PLANE', 'SMATPAY_API_URL', 'SMATPAY_MERCHANT_ID', 'SMATPAY_MERCHANT_ACCOUNT_ID', 'SMATPAY_PROFILE_NUMBER',
        'SMATPAY_SANDBOX_MERCHANT_KEY', 'SMATPAY_SANDBOX_MERCHANT_API_KEY', 'SMATPAY_MERCHANT_KEY', 'SMATPAY_MERCHANT_API_KEY'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    names.forEach((n) => delete process.env[n]);
    t.after(() => names.forEach((n) => (saved[n] === undefined ? delete process.env[n] : (process.env[n] = saved[n]))));
}

async function service(t) {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, body, headers = {'X-Admin-Key': 'admin-secret'}) => {
        const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        return {status: res.status, body: await res.json()};
    };
}

test('the admin saves merchant details; keys are never sent back', async (t) => {
    withKey(t);
    noEnv(t);
    memorySettings(t);
    const call = await service(t);

    const empty = await call('GET', '/api/admin/settings/payments');
    assert.strictEqual(empty.body.configured, false);
    assert.strictEqual(empty.body.plane, 'sandbox');
    assert.deepStrictEqual(empty.body.keys.sandbox_merchant_key, {set: false, last4: null, source: null});

    assert.strictEqual((await call('PUT', '/api/admin/settings/payments', {api_url: 'http://dev.smatpay.africa'})).body.error, 'api_url_must_be_https');
    assert.strictEqual((await call('PUT', '/api/admin/settings/payments', {plane: 'live'})).body.error, 'plane_must_be_sandbox_or_production');
    assert.strictEqual((await call('PUT', '/api/admin/settings/payments', {profile_number: '20a'})).body.error, 'invalid_profile_number');
    assert.strictEqual((await call('PUT', '/api/admin/settings/payments', {})).body.error, 'nothing_to_update');

    const saved = await call('PUT', '/api/admin/settings/payments', {
        plane: 'sandbox', api_url: 'https://dev.smatpay.africa:8443', merchant_id: '3591792570113353',
        account_id: '268', profile_number: '2032282', sandbox_merchant_key: 'sandbox-key-ABCD', sandbox_api_key: 'sandbox-api-WXYZ',
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.configured, true);
    assert.deepStrictEqual(saved.body.keys.sandbox_merchant_key, {set: true, last4: 'ABCD', source: 'admin'});
    assert.ok(!JSON.stringify(saved.body).includes('sandbox-key-ABCD'), 'the key itself is never in a reply');

    // Leaving a key blank keeps it; null clears it.
    const kept = await call('PUT', '/api/admin/settings/payments', {sandbox_merchant_key: '', profile_number: '2032283'});
    assert.strictEqual(kept.body.keys.sandbox_merchant_key.set, true);
    assert.strictEqual(kept.body.profile_number, '2032283');
    const cleared = await call('PUT', '/api/admin/settings/payments', {sandbox_api_key: null});
    assert.strictEqual(cleared.body.keys.sandbox_api_key.set, false);
    assert.strictEqual(cleared.body.configured, false);

    // The payment code uses what the admin saved.
    await call('PUT', '/api/admin/settings/payments', {sandbox_api_key: 'sandbox-api-WXYZ'});
    const m = await smatpay.merchant();
    assert.deepStrictEqual([m.sandbox, m.merchantId, m.merchantKey, m.merchantApiKey, m.profileNumber], [true, '3591792570113353', 'sandbox-key-ABCD', 'sandbox-api-WXYZ', '2032283']);

    assert.strictEqual((await call('GET', '/api/admin/settings/payments', null, {})).status, 401);
});

test('anything not saved falls back to the environment', async (t) => {
    withKey(t);
    noEnv(t);
    memorySettings(t);
    process.env.SMATPAY_API_URL = 'https://env.example';
    process.env.SMATPAY_SANDBOX_MERCHANT_KEY = 'env-key-1234';
    const call = await service(t);
    const view = (await call('GET', '/api/admin/settings/payments')).body;
    assert.deepStrictEqual([view.api_url, view.sources.api_url], ['https://env.example', 'environment']);
    assert.deepStrictEqual(view.keys.sandbox_merchant_key, {set: true, last4: '1234', source: 'environment'});

    await call('PUT', '/api/admin/settings/payments', {api_url: 'https://admin.example'});
    assert.strictEqual((await call('GET', '/api/admin/settings/payments')).body.sources.api_url, 'admin');
});

test('saving a key without an encryption key is refused', async (t) => {
    withKey(t, '');
    noEnv(t);
    memorySettings(t);
    const call = await service(t);
    const res = await call('PUT', '/api/admin/settings/payments', {sandbox_merchant_key: 'some-key-1234'});
    assert.deepStrictEqual(res, {status: 503, body: {error: 'encryption_key_missing'}});
});

test('checking the connection uses the form’s unsaved values and reports Smatpay’s answer', async (t) => {
    withKey(t);
    noEnv(t);
    memorySettings(t);
    let seen;
    stub(t, smatpay, {
        checkConnection: async (overrides) => {
            seen = overrides;
            if (overrides.sandbox_merchant_key === 'bad-key') throw new smatpay.PaymentError('Invalid merchant credentials', 'keys_refused');
            return {plane: 'sandbox', merchant: {name: 'TechWave Store', approved: false, account_id: '268'}, profiles: [{number: '2032282', name: 'Sandbox Profile', approved: true}]};
        },
    });
    const call = await service(t);
    const ok = await call('POST', '/api/admin/settings/payments/test', {merchant_id: '123456', sandbox_merchant_key: 'good-key', sandbox_api_key: ''});
    assert.strictEqual(ok.body.ok, true);
    assert.strictEqual(ok.body.profiles[0].number, '2032282');
    assert.deepStrictEqual(seen, {merchant_id: '123456', sandbox_merchant_key: 'good-key'}, 'blank fields use the saved ones');
    const bad = await call('POST', '/api/admin/settings/payments/test', {sandbox_merchant_key: 'bad-key'});
    assert.deepStrictEqual(bad, {status: 400, body: {ok: false, error: 'keys_refused', message: 'Invalid merchant credentials'}});
});
