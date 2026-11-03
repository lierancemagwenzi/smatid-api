// The client portal, against the database in .env (throwaway accounts, deleted afterwards).
// Emails and Smatpay are stood in for. Skipped when there's no database.
require('dotenv').config({quiet: true});
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const mailHelper = require('../helpers/mailHelper');
const smatpay = require('../helpers/payments/smatpayHelper');
const topupHelper = require('../helpers/billing/topupHelper');
const billing = require('../helpers/billing/billingHelper');
const account = require('../controllers/AccountController');

let available = false;
const RUN = `portal-test-${Date.now()}`;
const emailFor = (who) => `${who}-${RUN}@example.com`;

test.before(async () => {
    try {
        await db.sequelize.authenticate();
        await db.user.count();
        available = true;
    } catch {
        available = false;
    }
});
test.after(async () => {
    if (available) {
        const users = await db.user.findAll({where: {email: {[db.Sequelize.Op.like]: `%${RUN}@example.com`}}});
        const clientIds = [...new Set(users.map((u) => u.client_id))];
        await db.client.destroy({where: {id: clientIds}});
    }
    await db.sequelize.close();
});

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

/** Captures emails instead of sending them; `linkTo(email)` is the token in the latest one to that address. */
function inbox(t) {
    const mails = [];
    stub(t, mailHelper, {send: async (to, subject, content) => (mails.push({to, subject, content}), true)});
    return {
        mails,
        linkTo: (email) => {
            const mail = [...mails].reverse().find((m) => m.to === email && m.content.button && new URL(m.content.button.url).searchParams.get('token'));
            return mail ? new URL(mail.content.button.url).searchParams.get('token') : null;
        },
    };
}

async function service(t) {
    account.resetLimits();
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, {token, body} = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
            body: body && JSON.stringify(body),
        });
        return {status: res.status, body: await res.json()};
    };
}

/** Registers and verifies a company; returns its owner's session and the call helper. */
async function signedUpOwner(t, mail, call, who = 'owner') {
    const email = emailFor(who);
    await call('POST', '/api/portal/register', {body: {company_name: `Acme ${who}`, name: 'Ada Owner', email, password: 'correct horse battery'}});
    const verified = await call('POST', '/api/portal/verify-email', {body: {token: mail.linkTo(email)}});
    return {email, session: verified.body.token, verified};
}

test('register, confirm the email to start the trial, sign in', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const email = emailFor('signup');

    assert.strictEqual((await call('POST', '/api/portal/register', {body: {company_name: 'Acme', name: 'Ada', email, password: 'short'}})).body.error, 'password_too_short');
    assert.strictEqual((await call('POST', '/api/portal/register', {body: {name: 'Ada', email, password: 'correct horse battery'}})).body.error, 'company_name_required');

    const reg = await call('POST', '/api/portal/register', {body: {company_name: 'Acme Bank', name: 'Ada Owner', email: ` ${email.toUpperCase()} `, password: 'correct horse battery'}});
    assert.deepStrictEqual(reg, {status: 201, body: {registered: true, email}});
    assert.strictEqual(mail.mails[0].subject, 'Confirm your email for Smatid KYC');

    // Registering again doesn't say the email is taken; it emails the owner instead.
    assert.strictEqual((await call('POST', '/api/portal/register', {body: {company_name: 'X', name: 'Y', email, password: 'correct horse battery'}})).status, 201);
    assert.strictEqual(mail.mails[1].subject, 'You already have a Smatid KYC account');

    assert.strictEqual((await call('POST', '/api/portal/login', {body: {email, password: 'correct horse battery'}})).body.error, 'email_not_verified');

    const token = mail.linkTo(email);
    const verified = await call('POST', '/api/portal/verify-email', {body: {token}});
    assert.strictEqual(verified.status, 200);
    assert.match(verified.body.token, /^usr_/);
    assert.strictEqual(verified.body.user.role, 'owner');
    assert.strictEqual(verified.body.client.trial_active, true);
    assert.strictEqual(verified.body.client.available_credits, billing.config().trial_credits);
    assert.strictEqual(verified.body.client.has_api_token, false);
    assert.strictEqual((await call('POST', '/api/portal/verify-email', {body: {token}})).body.error, 'invalid_or_expired_link', 'links work once');

    assert.strictEqual((await call('POST', '/api/portal/login', {body: {email, password: 'wrong password!'}})).body.error, 'invalid_credentials');
    const login = await call('POST', '/api/portal/login', {body: {email, password: 'correct horse battery'}});
    assert.strictEqual(login.status, 200);
    const me = await call('GET', '/api/portal/me', {token: login.body.token});
    assert.strictEqual(me.body.client.name, 'Acme Bank');

    const ledger = await db.credit_transaction.findAll({where: {client_id: me.body.client.id}});
    assert.deepStrictEqual(ledger.map((l) => l.kind), ['trial_grant']);
});

test('forgot password: a reset link sets a new password and signs out everywhere', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const {email, session} = await signedUpOwner(t, mail, call, 'reset');

    assert.deepStrictEqual((await call('POST', '/api/portal/forgot-password', {body: {email: emailFor('nobody')}})).body, {sent: true}, 'same answer for unknown emails');
    await call('POST', '/api/portal/forgot-password', {body: {email}});
    const resetToken = mail.linkTo(email);
    assert.strictEqual(mail.mails.at(-1).subject, 'Reset your Smatid KYC password');

    const reset = await call('POST', '/api/portal/reset-password', {body: {token: resetToken, password: 'a brand new passphrase'}});
    assert.strictEqual(reset.status, 200);
    assert.strictEqual((await call('GET', '/api/portal/me', {token: session})).status, 401, 'old sessions end');
    assert.strictEqual((await call('POST', '/api/portal/login', {body: {email, password: 'correct horse battery'}})).status, 401);
    assert.strictEqual((await call('POST', '/api/portal/login', {body: {email, password: 'a brand new passphrase'}})).status, 200);
    assert.strictEqual((await call('POST', '/api/portal/reset-password', {body: {token: resetToken, password: 'another passphrase'}})).body.error, 'invalid_or_expired_link');
});

test('owners make the API token and manage the team; members can look but not manage', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const {session} = await signedUpOwner(t, mail, call, 'team');

    const made = await call('POST', '/api/portal/api-token', {token: session});
    assert.strictEqual(made.status, 201);
    assert.match(made.body.access_token, /^kyc_/);
    // The token works on the KYC API.
    const client = await db.client.findOne({where: {token_prefix: made.body.token_prefix}});
    assert.ok(client);

    const memberEmail = emailFor('member');
    const invited = await call('POST', '/api/portal/team', {token: session, body: {name: 'Mo Member', email: memberEmail}});
    assert.strictEqual(invited.status, 201);
    assert.strictEqual(invited.body.user.invited, true);
    assert.strictEqual((await call('POST', '/api/portal/team', {token: session, body: {name: 'Again', email: memberEmail}})).body.error, 'email_taken');

    const accepted = await call('POST', '/api/portal/reset-password', {body: {token: mail.linkTo(memberEmail), password: 'member passphrase 1'}});
    assert.strictEqual(accepted.status, 200);
    assert.strictEqual(accepted.body.user.role, 'member');
    assert.strictEqual(accepted.body.client.id, client.id);
    const memberSession = accepted.body.token;

    assert.strictEqual((await call('GET', '/api/portal/dashboard', {token: memberSession})).status, 200);
    assert.strictEqual((await call('POST', '/api/portal/api-token', {token: memberSession})).body.error, 'owner_only');
    assert.strictEqual((await call('POST', '/api/portal/team', {token: memberSession, body: {name: 'X', email: emailFor('x')}})).body.error, 'owner_only');

    const team = await call('GET', '/api/portal/team', {token: session});
    assert.deepStrictEqual(team.body.users.map((u) => u.role).sort(), ['member', 'owner']);
    const owner = team.body.users.find((u) => u.role === 'owner');
    assert.strictEqual((await call('DELETE', `/api/portal/team/${owner.id}`, {token: session})).body.error, 'cannot_remove_yourself');
    const member = team.body.users.find((u) => u.role === 'member');
    assert.strictEqual((await call('DELETE', `/api/portal/team/${member.id}`, {token: session})).status, 200);
    assert.strictEqual((await call('GET', '/api/portal/me', {token: memberSession})).status, 401, 'removed users are signed out');
});

test('a top-up is paid through Smatpay and credited exactly once', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const {session} = await signedUpOwner(t, mail, call, 'topup');
    let smatpayStatus = 'Pending';
    const asked = [];
    stub(t, smatpay, {
        configured: () => true,
        requestPayment: async (p) => (asked.push(p), {status: 'Pending', paymentReference: `PAY-${p.reference}`, paymentCode: null, paymentRedirectUrl: null}),
        trackPayment: async () => ({status: smatpayStatus}),
    });

    const options = await call('GET', '/api/portal/topup-options', {token: session});
    assert.strictEqual(options.body.available, true);
    assert.ok(options.body.methods.some((m) => m.id === 'ECOCASH' && m.needs_mobile));

    assert.strictEqual((await call('POST', '/api/portal/topups', {token: session, body: {credits: 1, method: 'ECOCASH', mobile: '0771234567'}})).body.error, 'invalid_credits');
    assert.strictEqual((await call('POST', '/api/portal/topups', {token: session, body: {credits: 100, method: 'ECOCASH', mobile: '0712345678'}})).body.error, 'invalid_mobile');
    assert.strictEqual((await call('POST', '/api/portal/topups', {token: session, body: {credits: 100, method: 'BITCOIN'}})).body.error, 'invalid_method');

    const created = await call('POST', '/api/portal/topups', {token: session, body: {credits: 100, method: 'ECOCASH', mobile: '+263 77 123 4567'}});
    assert.strictEqual(created.status, 201);
    const topup = created.body.topup;
    assert.strictEqual(topup.status, 'pending');
    assert.strictEqual(topup.amount, billing.priceOf(100));
    assert.strictEqual(asked[0].payerMobile, '0771234567');

    assert.strictEqual((await call('GET', `/api/portal/topups/${topup.id}`, {token: session})).body.topup.status, 'pending');
    const before = (await call('GET', '/api/portal/me', {token: session})).body.client.credits;

    smatpayStatus = 'Paid';
    // The poller and the person's page both notice at once: it must still only be credited once.
    const row = await db.topup.findByPk(topup.id);
    await Promise.all([topupHelper.markPaid(row.id, 'Paid'), topupHelper.markPaid(row.id, 'Paid'), call('GET', `/api/portal/topups/${topup.id}`, {token: session})]);
    const after = await call('GET', `/api/portal/topups/${topup.id}`, {token: session});
    assert.strictEqual(after.body.topup.status, 'paid');
    assert.strictEqual(after.body.balance.credits, before + 100);
    const credits = await db.credit_transaction.findAll({where: {topup_id: topup.id}});
    assert.strictEqual(credits.length, 1, 'credited once');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(mail.mails.some((m) => m.subject === 'Receipt: 100 Smatid KYC credits'));
});

test('portal calls need a session, and only see their own company', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    assert.strictEqual((await call('GET', '/api/portal/dashboard')).status, 401);
    assert.strictEqual((await call('GET', '/api/portal/dashboard', {token: 'usr_nope'})).status, 401);
    const a = await signedUpOwner(t, mail, call, 'iso-a');
    const b = await signedUpOwner(t, mail, call, 'iso-b');
    const bRequest = await db.api_request.create({
        client_id: b.verified.body.client.id, check_type: 'company', method: 'GET', path: '/x', status: 200, request: {}, response: {},
    });
    assert.strictEqual((await call('GET', `/api/portal/usage/${bRequest.id}`, {token: a.session})).status, 404);
    assert.strictEqual((await call('GET', `/api/portal/usage/${bRequest.id}`, {token: b.session})).status, 200);
});

test('a portal user runs company and sanctions checks, charged and logged like API calls', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const {session} = await signedUpOwner(t, mail, call, 'checks');
    const cipzHelper = require('../helpers/cipz/cipzHelper');
    const yenteHelper = require('../helpers/sanctions/yenteHelper');
    const asked = [];
    stub(t, cipzHelper, {checkCompany: async (number) => (asked.push(number), {found: true, name: 'ACME (PRIVATE) LIMITED', number, address: null, status: 'Verified', verified: true})});
    stub(t, yenteHelper, {screen: async (query) => (asked.push(query.properties.name[0]), {dataset: 'default', threshold: 0.7, hit: false, sanctioned: false, pep: false, matches: [], near_matches: []})});
    // Both checks on, at 2 credits each, whatever the modules table holds.
    const mod = (key) => db.kyc_module.build({key, name: key, status: 'enabled', credit_cost: 2});
    stub(t, db.kyc_module, {
        findOne: async ({where}) => mod(where.key),
        findAll: async ({where}) => where.key.map(mod),
    });

    assert.strictEqual((await call('POST', '/api/portal/checks/company', {body: {number: '1234/2010'}})).status, 401);
    const options = await call('GET', '/api/portal/checks', {token: session});
    assert.deepStrictEqual(options.body.checks.map((c) => [c.check_type, c.credit_cost, c.enabled]), [['company', 2, true], ['sanctions', 2, true]]);

    const before = (await call('GET', '/api/portal/me', {token: session})).body.client.available_credits;
    const company = await call('POST', '/api/portal/checks/company', {token: session, body: {number: ' 1234/2010 '}});
    assert.strictEqual(company.status, 200);
    assert.strictEqual(company.body.name, 'ACME (PRIVATE) LIMITED');
    const screened = await call('POST', '/api/portal/checks/sanctions', {token: session, body: {type: 'person', name: 'Ada Lovelace'}});
    assert.strictEqual(screened.status, 200);
    assert.strictEqual(screened.body.hit, false);
    assert.deepStrictEqual(asked, ['1234/2010', 'Ada Lovelace']);

    // A refused check is refunded.
    assert.deepStrictEqual((await call('POST', '/api/portal/checks/company', {token: session, body: {number: '!'}})).body, {error: 'invalid_registration_number'});
    assert.strictEqual((await call('POST', '/api/portal/checks/sanctions', {token: session, body: {type: 'person'}})).status, 400);
    // Refunds and log rows are written just after the reply.
    await new Promise((r) => setTimeout(r, 300));
    const me = (await call('GET', '/api/portal/me', {token: session})).body;
    assert.strictEqual(me.client.available_credits, before - 4);

    const logged = await db.api_request.findAll({where: {client_id: me.client.id}, order: [['id', 'ASC']]});
    assert.deepStrictEqual(logged.map((r) => [r.check_type, r.status, r.credits_charged]), [['company', 200, 2], ['sanctions', 200, 2], ['company', 400, 0], ['sanctions', 400, 0]]);
    assert.ok(logged[0].path.startsWith('/api/portal/checks/company'));
    // And they show in the portal's own usage list.
    assert.strictEqual((await call('GET', '/api/portal/usage', {token: session})).body.total, 4);
});

test('liveness test sessions from the portal are free, marked as tests, limited per day, and send webhooks', async (t) => {
    if (!available) return t.skip('no database');
    const mail = inbox(t);
    const call = await service(t);
    const {session} = await signedUpOwner(t, mail, call, 'livetest');
    const webhookHelper = require('../helpers/webhookHelper');
    const delivered = [];
    stub(t, webhookHelper, {send: async (url, event, payload) => delivered.push({url, event, payload})});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 5})});
    process.env.LIVENESS_TEST_DAILY_LIMIT = '3';
    t.after(() => delete process.env.LIVENESS_TEST_DAILY_LIMIT);
    await call('PUT', '/api/portal/webhook', {token: session, body: {webhook_url: 'https://hooks.example.com/smatid'}});
    const before = (await call('GET', '/api/portal/me', {token: session})).body.client.available_credits;

    assert.strictEqual((await call('POST', '/api/portal/liveness-tests', {body: {}})).status, 401);
    assert.deepStrictEqual((await call('POST', '/api/portal/liveness-tests', {token: session, body: {outcome: 'maybe'}})).body, {error: 'invalid_outcome'});

    const live = await call('POST', '/api/portal/liveness-tests', {token: session, body: {}});
    assert.strictEqual(live.status, 201);
    assert.deepStrictEqual([live.body.session.status, live.body.session.test, live.body.tests_left_today], ['pending', true, 2]);
    assert.match(live.body.session.url, /\/liveness\/lv_/);
    const page = await call('GET', `/api/liveness/${live.body.session.session_id}`);
    assert.strictEqual(page.body.test, true, 'the hosted page knows it is a test');

    const passed = await call('POST', '/api/portal/liveness-tests', {token: session, body: {outcome: 'passed'}});
    assert.deepStrictEqual([passed.body.session.status, passed.body.session.passed, passed.body.session.webhook.url], ['passed', true, 'https://hooks.example.com/smatid']);
    const failed = await call('POST', '/api/portal/liveness-tests', {token: session, body: {outcome: 'failed'}});
    assert.deepStrictEqual([failed.body.session.status, failed.body.session.failure_reason, failed.body.tests_left_today], ['failed', 'simulated_failure', 0]);
    assert.deepStrictEqual((await call('POST', '/api/portal/liveness-tests', {token: session, body: {}})).body, {error: 'test_limit_reached', limit: 3});

    // Webhooks go out just after the reply.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(delivered.map((d) => [d.event, d.payload.status, d.payload.test]), [['liveness.completed', 'passed', true], ['liveness.completed', 'failed', true]]);
    const shown = await call('GET', `/api/portal/liveness-tests/${passed.body.session.session_id}`, {token: session});
    assert.strictEqual(shown.body.session.webhook.status, 'delivered');

    const me = (await call('GET', '/api/portal/me', {token: session})).body;
    assert.strictEqual(me.client.available_credits, before, 'no credits used');
    assert.strictEqual((await call('GET', '/api/portal/usage', {token: session})).body.total, 0, 'not in usage');
});
