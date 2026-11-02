const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const webhookHelper = require('../helpers/webhookHelper');
const deliveryHelper = require('../helpers/liveness/deliveryHelper');
const tokenHelper = require('../helpers/tokenHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

function allowLocal(t) {
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
    t.after(() => delete process.env.WEBHOOK_ALLOW_PRIVATE);
}

/** A receiver on this machine that records what it gets and answers with `status`. */
async function receiver(t, status = 200, headers = {}) {
    const got = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            got.push({headers: req.headers, body});
            res.writeHead(status, headers);
            res.end('ok');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return {got, url: `http://127.0.0.1:${server.address().port}/hooks/kyc`};
}

test('private and internal addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
        assert.strictEqual(webhookHelper.isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '178.63.147.142', '172.32.0.1', '2a00:1450:4001::200e']) {
        assert.strictEqual(webhookHelper.isPrivateAddress(ip), false, ip);
    }
});

test('webhook URLs must be public https', () => {
    assert.strictEqual(webhookHelper.urlProblem('https://acme.co.zw/hooks'), null);
    assert.strictEqual(webhookHelper.urlProblem('http://acme.co.zw/hooks'), 'webhook_url_must_be_https');
    assert.strictEqual(webhookHelper.urlProblem('https://127.0.0.1/x'), 'webhook_url_not_public');
    assert.strictEqual(webhookHelper.urlProblem('https://[::1]/x'), 'webhook_url_not_public');
    assert.strictEqual(webhookHelper.urlProblem('https://169.254.169.254/latest'), 'webhook_url_not_public');
    assert.strictEqual(webhookHelper.urlProblem('https://localhost:8000/match'), 'webhook_url_not_public');
    assert.strictEqual(webhookHelper.urlProblem('https://user:pw@acme.co.zw/'), 'invalid_webhook_url');
    assert.strictEqual(webhookHelper.urlProblem('not a url'), 'invalid_webhook_url');
});

test('signatures verify, and fail when anything changes', () => {
    const body = JSON.stringify({a: 1});
    const header = webhookHelper.sign('whsec_x', body);
    assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.strictEqual(webhookHelper.verify('whsec_x', body, header), true);
    assert.strictEqual(webhookHelper.verify('whsec_y', body, header), false);
    assert.strictEqual(webhookHelper.verify('whsec_x', body + ' ', header), false);
    const old = webhookHelper.sign('whsec_x', body, Math.floor(Date.now() / 1000) - 3600);
    assert.strictEqual(webhookHelper.verify('whsec_x', body, old), false, 'too old');
});

test('a webhook is sent signed, and a non-2xx reply or a redirect counts as failed', async (t) => {
    allowLocal(t);
    const ok = await receiver(t, 200);
    assert.strictEqual(await webhookHelper.send(ok.url, 'liveness.completed', {session_id: 'lv_1', status: 'passed'}, 'whsec_test'), 200);
    const [delivery] = ok.got;
    assert.strictEqual(delivery.headers['smatid-event'], 'liveness.completed');
    assert.strictEqual(webhookHelper.verify('whsec_test', delivery.body, delivery.headers['smatid-signature']), true);
    const parsed = JSON.parse(delivery.body);
    assert.match(parsed.id, /^evt_/);
    assert.deepStrictEqual(parsed.data, {session_id: 'lv_1', status: 'passed'});

    const down = await receiver(t, 500);
    await assert.rejects(webhookHelper.send(down.url, 'liveness.completed', {}, 's'), /HTTP 500/);
    const moved = await receiver(t, 302, {Location: 'http://169.254.169.254/'});
    await assert.rejects(webhookHelper.send(moved.url, 'liveness.completed', {}, 's'), /HTTP 302/);

    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    await assert.rejects(webhookHelper.send(ok.url, 'liveness.completed', {}, 's'), /webhook_url_must_be_https/);
});

test('retries wait longer each time, then stop', () => {
    const at = (n) => webhookHelper.nextAttemptAt(n);
    assert.ok(at(1) - Date.now() > 25 * 1000);
    assert.ok(at(2) - Date.now() > 4 * 60 * 1000);
    assert.ok(at(3) - Date.now() > 25 * 60 * 1000);
    assert.strictEqual(at(4), null);
});

/** A finished session with a webhook, its client and an in-memory update. */
function pendingSession(fields = {}) {
    const client = db.client.build({id: 1, name: 'Acme', status: 'active', webhook_secret: 'whsec_acme'});
    client.update = async (c) => Object.assign(client, c);
    const s = db.liveness_session.build({
        id: 1, public_id: 'lv_' + 'a'.repeat(32), client_id: 1, status: 'passed', attempts: 1,
        webhook_url: 'https://acme.co.zw/hooks', webhook_status: 'pending', webhook_attempts: 0,
        webhook_next_at: new Date(), expires_at: new Date(Date.now() + 60000), ...fields,
    });
    s.client = client;
    s.update = async (c) => Object.assign(s, c);
    return s;
}

test('delivery marks a webhook delivered, or schedules a retry, or gives up', async (t) => {
    const session = pendingSession();
    stub(t, db.liveness_session, {findAll: async () => (session.webhook_status === 'pending' ? [session] : [])});
    const sent = [];
    let fail = true;
    stub(t, webhookHelper, {send: async (url, event, data, secret) => {
        sent.push({url, event, data, secret});
        if (fail) throw new Error('HTTP 503');
        return 200;
    }});

    await deliveryHelper.deliverDue();
    assert.strictEqual(session.webhook_status, 'pending');
    assert.strictEqual(session.webhook_attempts, 1);
    assert.strictEqual(session.webhook_last_error, 'HTTP 503');
    assert.ok(session.webhook_next_at > new Date(), 'retry later');
    assert.strictEqual(sent[0].secret, 'whsec_acme');
    assert.strictEqual(sent[0].event, 'liveness.completed');
    assert.strictEqual(sent[0].data.status, 'passed');

    fail = false;
    session.webhook_next_at = new Date();
    await deliveryHelper.deliverDue();
    assert.strictEqual(session.webhook_status, 'delivered');
    assert.strictEqual(session.webhook_attempts, 2);
    assert.ok(session.webhook_delivered_at);

    // Out of tries.
    const last = pendingSession({webhook_attempts: 3});
    stub(t, db.liveness_session, {findAll: async () => (last.webhook_status === 'pending' ? [last] : [])});
    fail = true;
    await deliveryHelper.deliverDue();
    assert.strictEqual(last.webhook_status, 'failed');
    assert.strictEqual(last.webhook_next_at, null);
});

test('stale sessions expire and queue their webhook', async (t) => {
    const stale = pendingSession({status: 'pending', webhook_status: null, expires_at: new Date(Date.now() - 1000)});
    const noHook = pendingSession({status: 'started', webhook_url: null, webhook_status: null, expires_at: new Date(Date.now() - 1000)});
    stub(t, db.liveness_session, {findAll: async () => [stale, noHook]});
    assert.strictEqual(await deliveryHelper.expireStale(), 2);
    assert.strictEqual(stale.status, 'expired');
    assert.strictEqual(stale.webhook_status, 'pending');
    assert.strictEqual(noHook.status, 'expired');
    assert.strictEqual(noHook.webhook_status, null);
});

// ----- The client-facing parts -----

async function service(t) {
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, {headers = {}, body} = {}) => {
        const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        return {status: res.status, body: await res.json()};
    };
}

test('sessions take app links and webhook URLs, and refuse unsafe ones', async (t) => {
    const client = db.client.build({id: 1, name: 'Acme', status: 'active'});
    client.update = async (c) => Object.assign(client, c);
    stub(t, db.client, {findOne: async () => client});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: 'x', status: 'enabled'})});
    const logged = [];
    stub(t, db.api_request, {create: async (r) => logged.push(r)});
    stub(t, db.liveness_session, {create: async (f) => Object.assign(db.liveness_session.build(f), {createdAt: new Date()})});
    const call = await service(t);
    const auth = {Authorization: `Bearer ${tokenHelper.newToken()}`};
    const open = (body) => call('POST', '/api/kyc/liveness', {headers: auth, body});

    assert.strictEqual((await open({redirect_url: 'acmebank://kyc/done'})).status, 201, 'a mobile app link');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'http://acme.co.zw/']) {
        assert.strictEqual((await open({redirect_url: bad})).body.error, 'invalid_redirect_url', bad);
    }
    const hooked = await open({webhook_url: 'https://acme.co.zw/hooks'});
    assert.deepStrictEqual(hooked.body.webhook, {url: 'https://acme.co.zw/hooks', status: null, attempts: 0, delivered_at: null, last_error: null});
    assert.strictEqual((await open({webhook_url: 'http://acme.co.zw/hooks'})).body.error, 'webhook_url_must_be_https');
    assert.strictEqual((await open({webhook_url: 'https://localhost:8000/'})).body.error, 'webhook_url_not_public');

    // The client fetches its signing secret, and can replace it. Neither call is logged.
    const before = logged.length;
    const first = await call('GET', '/api/kyc/webhook-secret', {headers: auth});
    assert.match(first.body.webhook_secret, /^whsec_/);
    assert.strictEqual((await call('GET', '/api/kyc/webhook-secret', {headers: auth})).body.webhook_secret, first.body.webhook_secret);
    const rotated = await call('POST', '/api/kyc/webhook-secret/rotate', {headers: auth});
    assert.notStrictEqual(rotated.body.webhook_secret, first.body.webhook_secret);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(logged.length, before, 'secrets never go in the request log');
});

test('a client sets its default webhook, and sessions use it unless they give their own', async (t) => {
    const client = db.client.build({id: 1, name: 'Acme', status: 'active'});
    client.update = async (c) => Object.assign(client, c);
    stub(t, db.client, {findOne: async () => client});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: 'x', status: 'enabled'})});
    stub(t, db.api_request, {create: async () => {}});
    stub(t, db.liveness_session, {create: async (f) => Object.assign(db.liveness_session.build(f), {createdAt: new Date()})});
    const call = await service(t);
    const auth = {Authorization: `Bearer ${tokenHelper.newToken()}`};

    assert.deepStrictEqual((await call('GET', '/api/kyc/webhook', {headers: auth})).body, {webhook_url: null});
    assert.strictEqual((await call('PUT', '/api/kyc/webhook', {headers: auth, body: {}})).body.error, 'webhook_url_required');
    assert.strictEqual((await call('PUT', '/api/kyc/webhook', {headers: auth, body: {webhook_url: 'http://acme.co.zw/h'}})).body.error, 'webhook_url_must_be_https');
    assert.strictEqual((await call('PUT', '/api/kyc/webhook', {headers: auth, body: {webhook_url: 'https://10.0.0.5/h'}})).body.error, 'webhook_url_not_public');

    const set = await call('PUT', '/api/kyc/webhook', {headers: auth, body: {webhook_url: ' https://acme.co.zw/hooks/default '}});
    assert.deepStrictEqual(set.body, {webhook_url: 'https://acme.co.zw/hooks/default'});
    assert.match(client.webhook_secret, /^whsec_/, 'a signing secret is ready');

    const open = (body) => call('POST', '/api/kyc/liveness', {headers: auth, body});
    assert.strictEqual((await open({})).body.webhook.url, 'https://acme.co.zw/hooks/default');
    assert.strictEqual((await open({webhook_url: 'https://acme.co.zw/hooks/this-one'})).body.webhook.url, 'https://acme.co.zw/hooks/this-one');

    assert.deepStrictEqual((await call('PUT', '/api/kyc/webhook', {headers: auth, body: {webhook_url: null}})).body, {webhook_url: null});
    assert.strictEqual((await open({})).body.webhook, null, 'no default, no webhook');
});

test('the admin sets or clears a client\'s default webhook', async (t) => {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    const client = db.client.build({id: 4, name: 'Acme', status: 'active', token_hash: 'h', token_prefix: 'kyc_abcdefgh'});
    client.update = async (c) => Object.assign(client, c);
    stub(t, db.client, {findByPk: async (id) => (String(id) === '4' ? client : null)});
    stub(t, db.api_request, {findAll: async () => []});
    const call = await service(t);
    const admin = {'X-Admin-Key': 'admin-secret'};

    assert.strictEqual((await call('PATCH', '/api/admin/clients/4', {headers: admin, body: {}})).body.error, 'nothing_to_update');
    assert.strictEqual((await call('PATCH', '/api/admin/clients/4', {headers: admin, body: {webhook_url: 'https://localhost/x'}})).body.error, 'webhook_url_not_public');
    assert.strictEqual((await call('PATCH', '/api/admin/clients/9', {headers: admin, body: {webhook_url: null}})).status, 404);
    const set = await call('PATCH', '/api/admin/clients/4', {headers: admin, body: {webhook_url: 'https://acme.co.zw/hooks'}});
    assert.strictEqual(set.body.client.webhook_url, 'https://acme.co.zw/hooks');
    assert.strictEqual(set.body.client.webhook_secret, undefined, 'the secret is never shown to the admin API');
    assert.match(client.webhook_secret, /^whsec_/);
    assert.strictEqual((await call('PATCH', '/api/admin/clients/4', {headers: admin, body: {webhook_url: ''}})).body.client.webhook_url, null);
    assert.strictEqual((await call('PATCH', '/api/admin/clients/4', {body: {webhook_url: null}})).status, 401);
});
