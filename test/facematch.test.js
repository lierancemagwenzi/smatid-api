const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const faceHelper = require('../helpers/liveness/faceHelper');
const embedHelper = require('../helpers/passport/faceEmbedHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

// Pictures are told apart by their last byte; the stubbed face model says who is in each.
const picture = (id) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64), Buffer.from([id])]);
const PEOPLE = {1: 'lee-chip', 2: 'lee-page', 3: 'lee-live', 4: 'stranger', 5: 'nobody'};

/** A scan, a liveness session and their pictures on disk, with an in-memory database. */
function world(t, {livenessStatus = 'passed', chip = true, similarity = {}} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facematch-'));
    const passportDir = path.join(dir, 'passport');
    const livenessDir = path.join(dir, 'liveness');
    process.env.PASSPORT_STORAGE_DIR = passportDir;
    process.env.LIVENESS_STORAGE_DIR = livenessDir;
    t.after(() => {
        delete process.env.PASSPORT_STORAGE_DIR;
        delete process.env.LIVENESS_STORAGE_DIR;
        fs.rmSync(dir, {recursive: true, force: true});
    });

    const scanId = 'ps_' + 'a'.repeat(32);
    fs.mkdirSync(path.join(passportDir, scanId), {recursive: true});
    fs.writeFileSync(path.join(passportDir, `${scanId}.jpg`), picture(2));
    if (chip) fs.writeFileSync(path.join(passportDir, scanId, 'chip-photo.jpg'), picture(1));
    const scan = db.passport_scan.build({
        id: 1, public_id: scanId, client_id: 1, status: 'passed', image_file: `${scanId}.jpg`, createdAt: new Date(),
        chip: chip ? {status: 'verified'} : null, chip_photo_file: chip ? `${scanId}/chip-photo.jpg` : null,
    });
    scan.update = async (c) => Object.assign(scan, c);

    const sessions = {};
    const addSession = (id, clientId, livePicture) => {
        fs.mkdirSync(path.join(livenessDir, id), {recursive: true});
        fs.writeFileSync(path.join(livenessDir, id, 'attempt-1-0-center.jpg'), picture(livePicture));
        sessions[id] = db.liveness_session.build({
            id: Object.keys(sessions).length + 1, public_id: id, client_id: clientId, status: livenessStatus, attempts: 1,
            expires_at: new Date(Date.now() + 60000),
        });
    };
    addSession('lv_' + 'l'.repeat(32), 1, 3);
    addSession('lv_' + 's'.repeat(32), 1, 4);
    addSession('lv_' + 'n'.repeat(32), 1, 5);
    addSession('lv_' + 'o'.repeat(32), 2, 3);

    stub(t, db.passport_scan, {findOne: async ({where}) => (where.public_id === scan.public_id && where.client_id === 1 ? scan : null)});
    stub(t, db.liveness_session, {findOne: async ({where}) => {
        const s = sessions[where.public_id];
        return s && s.client_id === where.client_id ? s : null;
    }});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    stub(t, db.api_request, {create: async () => {}});
    stub(t, db.client, {findOne: async () => Object.assign(db.client.build({id: 1, name: 'Acme', status: 'active'}), {update: async () => {}})});

    // The face models, stubbed: each picture's "descriptor" is who is in it.
    const compared = [];
    stub(t, faceHelper, {
        decode: (buf) => ({who: PEOPLE[buf[buf.length - 1]]}),
        measure: async (buf) => {
            const who = PEOPLE[buf[buf.length - 1]];
            if (who === 'nobody') return {width: 10, height: 10, faces: []};
            return {width: 640, height: 480, faces: [{score: 0.95, box: [0, 0, 200, 200], landmarks: [[1, 1], [2, 1], [1.5, 2], [1, 3], [2, 3]]}]};
        },
    });
    stub(t, embedHelper, {
        embed: async (image) => image.who,
        cosine: (a, b) => {
            compared.push([a, b]);
            return similarity[`${a}~${b}`] ?? (b === 'stranger' ? 0.1 : 0.62);
        },
    });
    return {scan, compared};
}

async function service(t) {
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (body) => {
        const res = await fetch(`${base}/api/kyc/passport/ps_${'a'.repeat(32)}/face-match`, {
            method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer kyc_mine'}, body: JSON.stringify(body),
        });
        return {status: res.status, body: await res.json()};
    };
}

const lee = {liveness_session_id: 'lv_' + 'l'.repeat(32)};

test('the chip photo and a passed liveness check of the same person match, and verify the identity', async (t) => {
    const {scan, compared} = world(t);
    const call = await service(t);
    const res = await call(lee);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const m = res.body.face_match;
    assert.strictEqual(m.status, 'match');
    assert.strictEqual(m.matched, true);
    assert.strictEqual(m.similarity, 0.62);
    assert.strictEqual(m.model, 'sface-2021dec');
    assert.strictEqual(m.passport_photo, 'chip');
    assert.strictEqual(m.identity_verified, true);
    assert.deepStrictEqual(compared, [['lee-chip', 'lee-live']], 'the chip photo is preferred to the photo page');
    assert.strictEqual(scan.face_match.liveness_session_id, lee.liveness_session_id);
});

test('without a chip read, the photo page is used, and the identity is not fully verified', async (t) => {
    const {compared} = world(t, {chip: false});
    const call = await service(t);
    const m = (await call(lee)).body.face_match;
    assert.strictEqual(m.passport_photo, 'photo_page');
    assert.strictEqual(m.status, 'match');
    assert.strictEqual(m.identity_verified, false, 'no verified chip');
    assert.deepStrictEqual(compared, [['lee-page', 'lee-live']]);
});

test('a different face is no_match, and a close call is review', async (t) => {
    world(t, {similarity: {'lee-chip~lee-live': 0.31}});
    const call = await service(t);
    const stranger = (await call({liveness_session_id: 'lv_' + 's'.repeat(32)})).body.face_match;
    assert.strictEqual(stranger.status, 'no_match');
    assert.strictEqual(stranger.identity_verified, false);
    const close = (await call(lee)).body.face_match;
    assert.strictEqual(close.status, 'review');
    assert.strictEqual(close.matched, false);
});

test('only a passed liveness check of this client counts, and pictures without a face are refused', async (t) => {
    world(t);
    const call = await service(t);
    assert.strictEqual((await call({})).body.error, 'liveness_session_id_required');
    assert.strictEqual((await call({liveness_session_id: 'lv_' + 'o'.repeat(32)})).status, 404, "another client's session");
    const none = await call({liveness_session_id: 'lv_' + 'n'.repeat(32)});
    assert.strictEqual(none.status, 422);
    assert.strictEqual(none.body.error, 'no_face_in_liveness');
});

test('alignment: the similarity transform puts landmarks on the template', () => {
    // A face twice the template's size, shifted and turned 30 degrees.
    const turn = Math.PI / 6;
    const src = embedHelper.TEMPLATE.map(([x, y]) => [
        2 * (x * Math.cos(turn) - y * Math.sin(turn)) + 300, 2 * (x * Math.sin(turn) + y * Math.cos(turn)) + 120,
    ]);
    const [a, b, tx, ty] = embedHelper.similarityTransform(src, embedHelper.TEMPLATE);
    src.forEach(([x, y], i) => {
        assert.ok(Math.abs(a * x - b * y + tx - embedHelper.TEMPLATE[i][0]) < 1e-6);
        assert.ok(Math.abs(b * x + a * y + ty - embedHelper.TEMPLATE[i][1]) < 1e-6);
    });
    assert.strictEqual(embedHelper.landmarksFromMesh(new Array(100).fill([0, 0, 0])), null);
});

test('the SFace model loads and gives a 128-number descriptor of length 1', async () => {
    const image = {width: 200, height: 200, data: new Uint8Array(200 * 200 * 3).fill(128)};
    const d = await embedHelper.embed(image, embedHelper.TEMPLATE.map(([x, y]) => [x + 40, y + 40]));
    assert.strictEqual(d.length, 128);
    assert.ok(Math.abs(embedHelper.cosine(d, d) - 1) < 1e-5);
});

test('a liveness check that did not pass is refused', async (t) => {
    world(t, {livenessStatus: 'failed'});
    const call = await service(t);
    const res = await call(lee);
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(res.body, {error: 'liveness_not_passed', liveness_status: 'failed'});
});
