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
