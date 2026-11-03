// Credits need real database transactions and row locks, so these run against the database in .env,
// on a throwaway client that's deleted afterwards. Skipped when there's no database.
require('dotenv').config({quiet: true});
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const billing = require('../helpers/billing/billingHelper');
const tokenHelper = require('../helpers/tokenHelper');
const cipzHelper = require('../helpers/cipz/cipzHelper');

let available = false;
test.before(async () => {
    try {
        await db.sequelize.authenticate();
        await db.credit_transaction.count();
        available = true;
    } catch {
        available = false;
    }
});
test.after(() => db.sequelize.close());

async function throwawayClient(t, fields = {}) {
    if (!available) return t.skip('no database');
    const token = tokenHelper.newToken();
    const client = await db.client.create({
        name: `Billing test ${Date.now()}`, email: 'billing-test@example.com',
        token_hash: tokenHelper.sha256(token), token_prefix: tokenHelper.prefixOf(token), ...fields,
    });
    t.after(() => client.destroy());
    return {client, token};
}

const ledger = async (client) => (await db.credit_transaction.findAll({where: {client_id: client.id}, order: [['id', 'ASC']]}))
    .map((e) => [e.kind, e.credits, e.trial_credits]);

test('the trial is granted once, and its credits are spent before paid ones', async (t) => {
    const made = await throwawayClient(t, {credits: 10});
    if (!made) return;
    const {client} = made;
    await billing.startTrial(client.id);
    await billing.startTrial(client.id);
    await client.reload();
    const {trial_credits: trialCredits, trial_days: days} = billing.config();
    assert.strictEqual(client.trial_credits, trialCredits);
    assert.ok(Math.abs(new Date(client.trial_until) - Date.now() - days * 86400000) < 60000);

    const r = await billing.reserve(client.id, trialCredits + 3, 'sanctions');
    assert.deepStrictEqual([r.fromTrial, r.fromPaid], [trialCredits, 3]);
    await client.reload();
    assert.deepStrictEqual([client.credits, client.trial_credits], [7, 0]);

    await billing.refund(client.id, r, 'sanctions');
    await client.reload();
    assert.deepStrictEqual([client.credits, client.trial_credits], [10, trialCredits]);
    assert.deepStrictEqual(await ledger(client), [
        ['trial_grant', 0, trialCredits], ['usage', -3, -trialCredits], ['refund', 3, trialCredits],
    ]);
});

test('not enough credits is refused, and nothing is taken', async (t) => {
    const made = await throwawayClient(t, {credits: 2});
    if (!made) return;
    await assert.rejects(billing.reserve(made.client.id, 3, 'liveness'), (err) => err instanceof billing.InsufficientCredits && err.available === 2);
    await made.client.reload();
    assert.strictEqual(made.client.credits, 2);
});

test('expired trial credits stop counting and are written off', async (t) => {
    const made = await throwawayClient(t, {credits: 1, trial_credits: 40, trial_until: new Date(Date.now() - 1000)});
    if (!made) return;
    assert.strictEqual(made.client.balance().available_credits, 1);
    const r = await billing.reserve(made.client.id, 1, 'company');
    assert.deepStrictEqual([r.fromTrial, r.fromPaid], [0, 1]);
    await made.client.reload();
    assert.deepStrictEqual([made.client.credits, made.client.trial_credits], [0, 0]);
    assert.deepStrictEqual((await ledger(made.client)).map((e) => e[0]), ['trial_expiry', 'usage']);
});

test('many checks at once never spend more than the balance', async (t) => {
    const made = await throwawayClient(t, {credits: 5});
    if (!made) return;
    const results = await Promise.allSettled(Array.from({length: 12}, () => billing.reserve(made.client.id, 1, 'company')));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 5);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof billing.InsufficientCredits));
    await made.client.reload();
    assert.strictEqual(made.client.credits, 0);
});

test('a completed check is charged its module cost; a refused one is refunded; no credits is a 402', async (t) => {
    const made = await throwawayClient(t, {credits: 3});
    if (!made) return;
    const original = cipzHelper.checkCompany;
    cipzHelper.checkCompany = async (number) => ({found: true, name: 'X (PRIVATE) LIMITED', number, address: 'Harare', status: 'Verified', verified: true});
    t.after(() => (cipzHelper.checkCompany = original));
    const logged = [];
    const originalCreate = db.api_request.create;
    db.api_request.create = async (row) => logged.push(row);
    t.after(() => (db.api_request.create = originalCreate));

    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const get = (number) => fetch(`http://127.0.0.1:${server.address().port}/api/kyc/company/${number}`, {headers: {Authorization: `Bearer ${made.token}`}});

    const cost = (await db.kyc_module.findOne({where: {key: 'companies-check'}})).credit_cost;
    assert.strictEqual((await get('ABC123')).status, 200);
    assert.strictEqual((await get('bad%20number')).status, 400);
    await new Promise((r) => setTimeout(r, 300));
    await made.client.reload();
    assert.strictEqual(made.client.credits, 3 - cost, 'the bad request was refunded');
    assert.deepStrictEqual(logged.map((l) => [l.status, l.credits_charged]), [[200, cost], [400, 0]]);

    await made.client.update({credits: 0});
    const refused = await get('ABC123');
    assert.strictEqual(refused.status, 402);
    assert.deepStrictEqual(await refused.json(), {error: 'insufficient_credits', credits_needed: cost, available_credits: 0});
});

test('a manual top-up is recorded as paid, credited at once, and counted apart from usage', async (t) => {
    const made = await throwawayClient(t, {credits: 5});
    if (!made) return;
    const {client} = made;
    const topupHelper = require('../helpers/billing/topupHelper');
    t.after(() => db.topup.destroy({where: {client_id: client.id}}));

    const {topup, client: after} = await topupHelper.recordManual({clientId: client.id, credits: 200, reference: 'BANK-991', note: 'Bank transfer'});
    assert.deepStrictEqual([topup.status, topup.method, topup.credits, Number(topup.amount)], ['paid', 'MANUAL', 200, billing.priceOf(200)]);
    assert.strictEqual(after.credits, 205);
    const free = await topupHelper.recordManual({clientId: client.id, credits: 10, amount: 0});
    assert.strictEqual(Number(free.topup.amount), 0);
    await assert.rejects(topupHelper.recordManual({clientId: 999999999, credits: 10}), (err) => err.code === 'client_not_found');

    const r = await billing.reserve(client.id, 4, 'sanctions');
    await billing.reserve(client.id, 2, 'company');
    await billing.refund(client.id, r, 'sanctions');
    await billing.reserve(client.id, 3, 'sanctions');
    assert.deepStrictEqual((await ledger(client)).slice(0, 2), [['topup', 200, 0], ['topup', 10, 0]]);

    const call = await adminService(t);
    const res = await call('GET', `/api/admin/clients/${client.id}/credit-usage`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([res.body.recent.credits_used, res.body.recent.checks, res.body.all_time.credits_used], [5, 2, 5]);
    assert.deepStrictEqual(res.body.recent.by_check.map((c) => [c.check_type, c.credits_used, c.checks]), [['sanctions', 3, 1], ['company', 2, 1]]);
});

/** The admin API on a random port, signed in with X-Admin-Key. */
async function adminService(t) {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, body) => {
        const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', 'X-Admin-Key': 'admin-secret'}, body: body && JSON.stringify(body)});
        return {status: res.status, body: await res.json()};
    };
}
