const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const livenessHelper = require('../helpers/liveness/livenessHelper');
const faceHelper = require('../helpers/liveness/faceHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

// A face as faceHelper.measure reports it, looking straight ahead unless told otherwise.
const face = (fields = {}) => ({score: 0.99, width_share: 0.4, turn: 0.5, mouth: 0.03, real: 0.8, embedding: [1, 0], ...fields});
const frame = (fields, count = 1) => ({width: 640, height: 480, faces: Array.from({length: count}, () => face(fields))});
const same = async () => 0.9;
const STEPS = ['center', 'turn_left', 'open_mouth', 'turn_right'];
const hashes = ['a', 'b', 'c', 'd'];

const good = () => [frame({}), frame({turn: 0.72}), frame({mouth: 0.25}), frame({turn: 0.28})];

test('steps start straight on, then the three challenges in a random order', () => {
    const orders = new Set();
    for (let i = 0; i < 60; i++) {
        const steps = livenessHelper.newSteps();
        assert.strictEqual(steps[0], 'center');
        assert.deepStrictEqual([...steps.slice(1)].sort(), ['open_mouth', 'turn_left', 'turn_right']);
        orders.add(steps.join());
    }
    assert.ok(orders.size > 1, 'the order changes');
});

test('a real-looking set of frames passes', async () => {
    const v = await livenessHelper.verify(STEPS, good(), hashes, same);
    assert.strictEqual(v.passed, true, JSON.stringify(v));
    assert.strictEqual(v.failure_reason, null);
    assert.deepStrictEqual(v.steps.map((s) => s.ok), [true, true, true, true]);
    assert.strictEqual(v.scores.similarity, 0.9);
});

test('each kind of bad frame fails with its own reason', async () => {
    const swap = (i, m) => good().map((x, j) => (j === i ? m : x));
    const cases = [
        [swap(0, frame({turn: 0.7})), 'not_facing_camera'],
        [swap(1, frame({turn: 0.3})), 'did_not_turn_left', 'turned the wrong way'],
        [swap(3, frame({turn: 0.55})), 'did_not_turn_right'],
        [swap(2, frame({mouth: 0.07})), 'mouth_not_open'],
        [swap(1, {width: 640, height: 480, faces: []}), 'no_face'],
        [swap(1, frame({turn: 0.72}, 2)), 'multiple_faces'],
        [swap(0, frame({width_share: 0.1})), 'face_too_small'],
        [good().map((m) => ({...m, faces: [{...m.faces[0], real: 0.2}]})), 'spoof_suspected'],
    ];
    for (const [frames, reason, note] of cases) {
        const v = await livenessHelper.verify(STEPS, frames, hashes, same);
        assert.strictEqual(v.failure_reason, reason, note || reason);
        assert.strictEqual(v.passed, false);
    }

    // A wide-open mouth in every frame doesn't count: it must open more than in the straight-on one.
    const alwaysOpen = good().map((m) => ({...m, faces: [{...m.faces[0], mouth: 0.25}]}));
    assert.strictEqual((await livenessHelper.verify(STEPS, alwaysOpen, hashes, same)).failure_reason, 'mouth_not_open');

    assert.strictEqual((await livenessHelper.verify(STEPS, good(), hashes, async () => 0.3)).failure_reason, 'different_person');

    // A turned head scores lower against the straight-on face; that alone isn't a different person.
    const turnedLower = async (a, b) => (b === 'turned' ? 0.37 : 0.7);
    const frames = good().map((m, i) => ({...m, faces: [{...m.faces[0], embedding: STEPS[i].startsWith('turn_') ? 'turned' : 'front'}]}));
    assert.strictEqual((await livenessHelper.verify(STEPS, frames, hashes, turnedLower)).passed, true);
    // But a face-on frame that low is still refused.
    const mouthLow = async (a, b) => (b === 'mouth' ? 0.37 : 0.7);
    const frames2 = good().map((m, i) => ({...m, faces: [{...m.faces[0], embedding: STEPS[i] === 'open_mouth' ? 'mouth' : 'x'}]}));
    assert.strictEqual((await livenessHelper.verify(STEPS, frames2, hashes, mouthLow)).failure_reason, 'different_person');
    assert.strictEqual((await livenessHelper.verify(STEPS, good(), ['a', 'a', 'c', 'd'], same)).failure_reason, 'duplicate_frames');
    assert.strictEqual((await livenessHelper.verify(STEPS, good().slice(0, 3), hashes.slice(0, 3), same)).failure_reason, 'wrong_frame_count');
});

test('turn and mouth measurements read the face mesh the right way round', () => {
    const mesh = Array.from({length: 468}, () => [0, 0, 0]);
    mesh[234] = [100, 200, 0];
    mesh[454] = [300, 200, 0];
    mesh[1] = [200, 220, 0];
    assert.strictEqual(faceHelper.turnOf(mesh), 0.5);
    // Nose towards the right of the picture: the person turned to their own left.
    mesh[1] = [260, 220, 0];
    assert.ok(faceHelper.turnOf(mesh) > 0.65);
    // Same picture with the cheek points the other way round gives the same answer.
    [mesh[234], mesh[454]] = [mesh[454], mesh[234]];
    assert.ok(faceHelper.turnOf(mesh) > 0.65);

    mesh[10] = [200, 100, 0];
    mesh[152] = [200, 300, 0];
    mesh[13] = [200, 240, 0];
    mesh[14] = [200, 280, 0];
    assert.strictEqual(faceHelper.mouthOf(mesh), 0.2);
});

// ----- Endpoints, with an in-memory sessions table -----

function sessionsTable(t) {
    const rows = [];
    const attach = (s) => {
        s.update = async (changes) => Object.assign(s, changes);
        s.client = {name: 'Acme Bank', status: 'active'};
        return s;
    };
    stub(t, db.liveness_session, {
        create: async (fields) => {
            const s = attach(db.liveness_session.build({id: rows.length + 1, ...fields, createdAt: new Date()}));
            rows.push(s);
            return s;
        },
        findOne: async ({where}) => rows.find((s) => s.public_id === where.public_id && (!where.client_id || s.client_id === where.client_id)) || null,
    });
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    stub(t, db.api_request, {create: async () => {}});
    stub(t, db.client, {findOne: async ({where}) => {
        const id = where.token_hash === tokenHelper.sha256('kyc_other') ? 2 : 1;
        return Object.assign(db.client.build({id, name: 'Acme Bank', status: 'active'}), {update: async () => {}});
    }});
    return rows;
}

async function service(t) {
    const app = express();
    app.use('/api/liveness', express.json({limit: '4mb'}));
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, path, {headers = {}, body} = {}) => {
        const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        const type = res.headers.get('content-type') || '';
        return {status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers};
    };
}

const client = {Authorization: 'Bearer kyc_mine'};

test('a client opens a session and gets a link to the hosted page', async (t) => {
    sessionsTable(t);
    process.env.PUBLIC_BASE_URL = 'https://dev-api.smatid.com/';
    t.after(() => delete process.env.PUBLIC_BASE_URL);
    const call = await service(t);

    assert.strictEqual((await call('POST', '/api/kyc/liveness', {headers: client, body: {redirect_url: 'http://evil.example/x'}})).body.error, 'invalid_redirect_url');
    assert.strictEqual((await call('POST', '/api/kyc/liveness', {headers: client, body: {redirect_url: 'javascript:alert(1)'}})).body.error, 'invalid_redirect_url');

    const res = await call('POST', '/api/kyc/liveness', {headers: client, body: {reference: 'cust-42', redirect_url: 'https://acme.co.zw/done'}});
    assert.strictEqual(res.status, 201);
    assert.match(res.body.session_id, /^lv_[A-Za-z0-9_-]{32}$/);
    assert.strictEqual(res.body.url, `https://dev-api.smatid.com/liveness/${res.body.session_id}`);
    assert.strictEqual(res.body.status, 'pending');
    assert.strictEqual(res.body.reference, 'cust-42');

    const mine = await call('GET', `/api/kyc/liveness/${res.body.session_id}`, {headers: client});
    assert.strictEqual(mine.body.status, 'pending');
    // Another client can't see it.
    assert.strictEqual((await call('GET', `/api/kyc/liveness/${res.body.session_id}`, {headers: {Authorization: 'Bearer kyc_other'}})).status, 404);
});

test('the hosted page runs an attempt; the server decides, and failures can be retried', async (t) => {
    sessionsTable(t);
    const call = await service(t);
    const {body: created} = await call('POST', '/api/kyc/liveness', {headers: client, body: {redirect_url: 'https://acme.co.zw/done?x=1'}});
    const sid = created.session_id;

    const page = await call('GET', `/liveness/${sid}`);
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /liveness\.js/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

    const info = (await call('GET', `/api/liveness/${sid}`)).body;
    assert.deepStrictEqual({...info, page_url: undefined},
        {status: 'pending', client_name: 'Acme Bank', attempts_left: 3, failure_reason: null, redirect_url: null, page_url: undefined});
    assert.match(info.page_url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/liveness/${sid}$`));
    assert.strictEqual((await call('GET', '/api/liveness/lv_nope')).status, 404);
    assert.strictEqual((await call('POST', `/api/liveness/${sid}/submit`, {body: {frames: []}})).body.error, 'not_started');

    // Attempt 1: the frames come straight back, too fast for a person.
    const start = await call('POST', `/api/liveness/${sid}/start`);
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.body.steps[0], 'center');
    assert.strictEqual(start.body.attempts_left, 2);
    assert.ok(start.body.thresholds.turn_min_offset > 0);
    const quick = await call('POST', `/api/liveness/${sid}/submit`, {body: {frames: ['a', 'b', 'c', 'd']}});
    assert.strictEqual(quick.body.passed, false);
    assert.strictEqual(quick.body.status, 'pending', 'tries left, so it can start again');
    assert.strictEqual(quick.body.failure_reason, 'too_fast');

    // Attempt 2: the server measures the frames and passes them.
    stub(t, faceHelper, {
        measure: async (buffer) => {
            const step = buffer.toString();
            return {center: frame({}), turn_left: frame({turn: 0.72}), turn_right: frame({turn: 0.28}), open_mouth: frame({mouth: 0.25})}[step];
        },
        similarity: async () => 0.9,
        load: async () => {},
    });
    process.env.LIVENESS_STORAGE_DIR = require('path').join(require('os').tmpdir(), `liveness-test-${process.pid}`);
    t.after(() => require('fs').rmSync(process.env.LIVENESS_STORAGE_DIR, {recursive: true, force: true}));
    t.after(() => delete process.env.LIVENESS_STORAGE_DIR);
    const second = await call('POST', `/api/liveness/${sid}/start`);
    const frames = second.body.steps.map((s) => Buffer.from(s).toString('base64'));
    await new Promise((r) => setTimeout(r, 2100));
    const done = await call('POST', `/api/liveness/${sid}/submit`, {body: {frames}});
    assert.strictEqual(done.body.passed, true, JSON.stringify(done.body));
    assert.strictEqual(done.body.status, 'passed');
    assert.strictEqual(done.body.redirect_url, `https://acme.co.zw/done?x=1&session_id=${sid}&status=passed`);

    const result = await call('GET', `/api/kyc/liveness/${sid}`, {headers: client});
    assert.strictEqual(result.body.status, 'passed');
    assert.strictEqual(result.body.passed, true);
    assert.strictEqual(result.body.attempts, 2);
    assert.strictEqual(result.body.steps.length, 4);
    assert.ok(result.body.completed_at);

    // A finished session can't be started again.
    assert.strictEqual((await call('POST', `/api/liveness/${sid}/start`)).body.error, 'session_closed');
});

test('an expired session is closed', async (t) => {
    const rows = sessionsTable(t);
    const call = await service(t);
    const {body} = await call('POST', '/api/kyc/liveness', {headers: client, body: {}});
    rows[0].expires_at = new Date(Date.now() - 1000);
    assert.strictEqual((await call('GET', `/api/liveness/${body.session_id}`)).body.status, 'expired');
    assert.strictEqual((await call('POST', `/api/liveness/${body.session_id}/start`)).status, 409);
    assert.strictEqual((await call('GET', `/api/kyc/liveness/${body.session_id}`, {headers: client})).body.status, 'expired');
});

test('the page only renders for a valid session from an active client while liveness is on', async (t) => {
    const rows = sessionsTable(t);
    const call = await service(t);
    const {body} = await call('POST', '/api/kyc/liveness', {headers: client, body: {}});
    const sid = body.session_id;

    assert.strictEqual((await call('GET', `/liveness/${sid}`)).status, 200);

    const unknown = await call('GET', '/liveness/lv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.strictEqual(unknown.status, 404);
    assert.match(unknown.body, /This link isn’t valid/);
    assert.doesNotMatch(unknown.body, /liveness\.js/, 'no camera page');
    assert.strictEqual((await call('GET', '/liveness/not-a-session')).status, 404);

    // The client that created it has been revoked.
    rows[0].client = {name: 'Acme Bank', status: 'revoked'};
    assert.strictEqual((await call('GET', `/liveness/${sid}`)).status, 404);
    assert.strictEqual((await call('GET', `/api/liveness/${sid}`)).status, 404);
    rows[0].client = {name: 'Acme Bank', status: 'active'};

    // Liveness switched off.
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'disabled'})});
    const off = await call('GET', `/liveness/${sid}`);
    assert.strictEqual(off.status, 403);
    assert.match(off.body, /isn’t available/);
});
