const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const zw = require('../helpers/idcard/countries/zw');
const idcard = require('../helpers/idcard');
const ocrInput = require('../helpers/idcard/ocrInput');
const idModel = require('../helpers/idcard/model');
const {parseDate} = require('../helpers/idcard/common');
const faceMatchHelper = require('../helpers/passport/faceMatchHelper');
const verificationHelper = require('../helpers/verification/verificationHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

/** A valid Zimbabwean ID number, with the right check letter. */
function idNumber(district = '63', serial = '1234567', origin = '42') {
    return `${district}-${serial} ${zw.expectedCheckLetter(district, serial)} ${origin}`;
}

const line = (text, x, y, w = 0.3, h = 0.04) => ({text, box: [x, y, w, h]});

/** The front of each kind of Zimbabwean card, as the app's OCR would give it. */
function cardOcr(type, {id = idNumber(), surname = 'MOYO', first = 'TARIRO GRACE', dob = '12/03/1990', jitter = () => 0} = {}) {
    const l = (text, x, y, w) => line(text, Math.max(0, x + jitter()), Math.max(0, y + jitter()), w);
    if (type === 'plastic') {
        return [l('REPUBLIC OF ZIMBABWE', 0.2, 0.03, 0.6), l('ID NUMBER', 0.35, 0.2), l(id, 0.35, 0.25), l('SURNAME', 0.35, 0.33), l(surname, 0.35, 0.38),
            l('FIRST NAME', 0.35, 0.46), l(first, 0.35, 0.51), l('DATE OF BIRTH', 0.35, 0.59), l(dob, 0.35, 0.64),
            l('VILLAGE OF ORIGIN', 0.35, 0.72), l('CHIKOMBA', 0.35, 0.77), l('PLACE OF BIRTH', 0.65, 0.59), l('HARARE', 0.65, 0.64),
            l('DATE OF ISSUE', 0.65, 0.72), l('05/06/2008', 0.65, 0.77)];
    }
    return [l(id, 0.1, 0.2, 0.6), l(surname, 0.1, 0.35), l(first, 0.1, 0.45), l(dob, 0.1, 0.55), l('CHIKOMBA', 0.5, 0.65)];
}

// ----- The Zimbabwean ID number -----

test('a Zimbabwean ID number is read, normalised and its check letter checked', () => {
    const letter = zw.expectedCheckLetter('63', '1234567');
    const id = zw.parseIdNumber(`ID No: 63-1234567 ${letter} 42`);
    assert.strictEqual(id.value, `63-1234567 ${letter} 42`);
    assert.deepStrictEqual([id.district, id.serial, id.origin_district], ['63', '1234567', '42']);
    assert.strictEqual(id.check_letter_valid, true);
    assert.strictEqual(id.corrected, false);

    // Without the dash or spaces, and with a six-digit serial.
    assert.strictEqual(zw.parseIdNumber(`08204782${zw.expectedCheckLetter('08', '204782')}13`).value, `08-204782 ${zw.expectedCheckLetter('08', '204782')} 13`);

    // A wrong check letter is read, and flagged.
    const wrong = zw.parseIdNumber('63-1234567 X 42');
    assert.strictEqual(wrong.check_letter_valid, false);
    assert.strictEqual(wrong.expected_check_letter, letter);

    assert.strictEqual(zw.parseIdNumber('12/03/1990'), null);
    assert.strictEqual(zw.parseIdNumber('REPUBLIC OF ZIMBABWE'), null);
    // Part of a longer number isn't an ID number.
    assert.strictEqual(zw.parseIdNumber(`1263-1234567 ${letter} 421`), null);
});

test('OCR look-alikes are fixed where only a digit, or only the check letter, can be', () => {
    const id = zw.parseIdNumber(`63-I23456T ${zw.expectedCheckLetter('63', '1234561')} 4Z`);
    assert.strictEqual(id.value, `63-1234561 ${zw.expectedCheckLetter('63', '1234561')} 42`);
    assert.strictEqual(id.corrected, true);
    // A check letter read as a digit: 8 for B.
    const serial = Array.from({length: 23}, (_, i) => String(1000000 + i)).find((s) => zw.expectedCheckLetter('63', s) === 'B');
    assert.strictEqual(zw.parseIdNumber(`63-${serial} 8 42`).value, `63-${serial} B 42`);
});

test('dates are read day first, in the forms printed on the cards', () => {
    assert.strictEqual(parseDate('12/03/1990'), '1990-03-12');
    assert.strictEqual(parseDate('DATE OF BIRTH 12-03-1990'), '1990-03-12');
    assert.strictEqual(parseDate('12.03.199O'), '1990-03-12');
    assert.strictEqual(parseDate('12 MAR 1990'), '1990-03-12');
    assert.strictEqual(parseDate('12MAR1990'), '1990-03-12');
    assert.strictEqual(parseDate('31/02/1990'), null);
    assert.strictEqual(parseDate('MOYO'), null);
});

// ----- The OCR the app sends -----

test('OCR lines are checked and sorted into rows, top to bottom and left to right', () => {
    const lines = ocrInput.parse({lines: [line('HARARE', 0.65, 0.64), line('12/03/1990', 0.35, 0.645), line('MOYO', 0.35, 0.38), line('  ', 0.1, 0.1)]});
    assert.deepStrictEqual(lines.map((l) => l.text), ['MOYO', '12/03/1990', 'HARARE']);
    assert.strictEqual(lines[1].row, lines[2].row);
    assert.deepStrictEqual(lines.map((l) => l.index), [0, 1, 2]);

    assert.throws(() => ocrInput.parse(undefined), {code: 'ocr_required'});
    assert.throws(() => ocrInput.parse({lines: []}), {code: 'ocr_required'});
    assert.throws(() => ocrInput.parse({lines: [{text: 'X', box: [0, 0, 2, 0.1]}]}), {code: 'invalid_ocr'});
    assert.throws(() => ocrInput.parse({lines: [{text: 'X'}]}), {code: 'invalid_ocr'});
    assert.throws(() => ocrInput.parse({lines: new Array(ocrInput.MAX_LINES + 1).fill(line('X', 0, 0))}), {code: 'invalid_ocr'});
});

test('where the card sat in the photo, and how big, doesn\'t change the read', () => {
    const near = ocrInput.parse(cardOcr('plastic'));
    const far = ocrInput.parse(cardOcr('plastic').map((l) => ({text: l.text, box: [0.3 + l.box[0] * 0.5, 0.2 + l.box[1] * 0.5, l.box[2] * 0.5, l.box[3] * 0.5]})));
    assert.deepStrictEqual(far.map((l) => l.box.map((v) => Math.round(v * 100))), near.map((l) => l.box.map((v) => Math.round(v * 100))));
    assert.deepStrictEqual(zw.rules(far).fields, zw.rules(near).fields);
});

// ----- Reading a card with the rules -----

test('the rules read each kind of Zimbabwean card', () => {
    const plastic = zw.rules(ocrInput.parse(cardOcr('plastic')));
    assert.strictEqual(plastic.card_type, 'plastic');
    assert.deepStrictEqual(plastic.fields, {
        id_number: idNumber(), surname: 'MOYO', first_names: 'TARIRO GRACE', date_of_birth: '1990-03-12',
        village_of_origin: 'CHIKOMBA', place_of_birth: 'HARARE', date_of_issue: '2008-06-05',
    });

    // No labels on the metal card: the names come as one, in the order printed.
    const metal = zw.rules(ocrInput.parse(cardOcr('metal')));
    assert.strictEqual(metal.card_type, 'metal');
    assert.strictEqual(metal.fields.full_name, 'MOYO TARIRO GRACE');
    assert.strictEqual(metal.fields.date_of_birth, '1990-03-12');
});

test('a clean read passes; a doubtful one is for review; an impossible one fails', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const read = (type, opts) => zw.check(zw.rules(ocrInput.parse(cardOcr(type, opts))), {now});

    const passed = read('plastic');
    assert.strictEqual(passed.status, 'passed');
    assert.strictEqual(passed.document.full_name, 'TARIRO GRACE MOYO');
    assert.strictEqual(passed.checks.id_check_letter, true);

    const metal = read('metal');
    assert.strictEqual(metal.status, 'review');
    assert.deepStrictEqual(metal.review_reasons, ['surname_not_separated']);

    const badLetter = read('plastic', {id: '63-1234567 X 42'});
    assert.strictEqual(badLetter.status, 'review');
    assert.ok(badLetter.review_reasons.includes('check_letter_mismatch'));

    const future = read('plastic', {dob: '12/03/2030'});
    assert.strictEqual(future.status, 'failed');
    assert.strictEqual(future.failure_reason, 'invalid_date_of_birth');

    // No ID number: nothing to check, the app should scan again.
    assert.strictEqual(zw.check(zw.rules(ocrInput.parse([line('REPUBLIC OF ZIMBABWE', 0.2, 0.1)]))), null);
});

test('with ZW_CHECK_LETTER_STRICT=1 a wrong check letter fails the scan', (t) => {
    process.env.ZW_CHECK_LETTER_STRICT = '1';
    t.after(() => delete process.env.ZW_CHECK_LETTER_STRICT);
    const result = zw.check(zw.rules(ocrInput.parse(cardOcr('plastic', {id: '63-1234567 X 42'}))));
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failure_reason, 'id_check_letter_mismatch');
});

// ----- Training a country's model -----

const SURNAMES = ['MOYO', 'NCUBE', 'DUBE', 'SIBANDA', 'CHIGUMBA', 'MUTASA', 'SHUMBA', 'NYATHI'];
const FIRST = ['TARIRO GRACE', 'TENDAI', 'BLESSING', 'RUVIMBO', 'TAKUDZWA', 'NYASHA'];

/** Labelled scans of both cards, with names, numbers and positions varying. */
function labelledScans(count) {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const out = [];
    for (let i = 0; i < count; i++) {
        const type = ['metal', 'plastic'][i % 2];
        const id = idNumber(String(10 + Math.floor(rand() * 70)), String(1000000 + Math.floor(rand() * 8999999)), String(10 + Math.floor(rand() * 80)));
        const surname = pick(SURNAMES);
        const first = pick(FIRST);
        const dob = `${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}/${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}/${1950 + Math.floor(rand() * 55)}`;
        const lines = ocrInput.parse(cardOcr(type, {id, surname, first, dob, jitter: () => (rand() - 0.5) * 0.03}));
        out.push({lines, label: {card_type: type, fields: {id_number: id, surname, first_names: first, date_of_birth: dob}}});
    }
    return out;
}

test('a model trained on labelled scans learns the unlabelled metal card the rules can\'t split', () => {
    const trained = idModel.train(labelledScans(90), zw, {version: 3});
    assert.strictEqual(trained.metrics.tested_on, 'held_out');
    assert.strictEqual(trained.samples.test, 18);
    assert.strictEqual(trained.active, true);
    assert.ok(trained.metrics.model.overall > trained.metrics.rules.overall, JSON.stringify(trained.metrics.model.overall));
    assert.ok(trained.metrics.model.fields.surname.accuracy >= 0.95);
    assert.ok(trained.metrics.model.card_type.accuracy >= 0.95);

    const metal = idModel.extract(trained, ocrInput.parse(cardOcr('metal', {surname: 'NCUBE', first: 'TENDAI'})), zw);
    assert.strictEqual(metal.fields.surname, 'NCUBE');
    assert.strictEqual(metal.fields.first_names, 'TENDAI');
    assert.strictEqual(metal.card_type, 'metal');
    assert.ok(metal.confidence.surname > 0.3);
});

test('a model trained on too few scans is saved but not used', () => {
    const trained = idModel.train(labelledScans(12), zw);
    assert.strictEqual(trained.active, false);
    assert.strictEqual(trained.samples.min_needed, 30);
});

test('saved models are loaded per country; only an active one reads cards, and the old one is kept', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-models-'));
    process.env.ID_MODEL_DIR = dir;
    idModel.reload();
    t.after(() => {
        delete process.env.ID_MODEL_DIR;
        idModel.reload();
        fs.rmSync(dir, {recursive: true, force: true});
    });
    const lines = ocrInput.parse(cardOcr('metal'));
    assert.strictEqual(idcard.read(zw, lines).extracted_by, 'rules:ZW');

    const trained = idModel.train(labelledScans(90), zw, {version: 1});
    idModel.save(trained);
    idModel.save({...trained, version: 2});
    assert.ok(fs.existsSync(path.join(dir, 'ZW.v1.json')));
    const read = idcard.read(zw, lines);
    assert.strictEqual(read.extracted_by, 'model:ZW@2');
    assert.strictEqual(read.fields.surname, 'MOYO');
    assert.strictEqual(read.fields.full_name, undefined);
    assert.strictEqual(idModel.summary('ZW').usable, true);

    idModel.save({...trained, version: 3, active: false});
    assert.strictEqual(idcard.read(zw, lines).extracted_by, 'rules:ZW');
});

test('countries are found by alpha-2 or alpha-3 code', () => {
    assert.strictEqual(idcard.profile('zw'), zw);
    assert.strictEqual(idcard.profile('ZWE'), zw);
    assert.strictEqual(idcard.profile('ZA'), null);
});

// ----- The endpoints -----

function scansTable(t) {
    const rows = [];
    const attach = (s) => {
        s.update = async (changes) => Object.assign(s, changes);
        return s;
    };
    stub(t, db.id_card_scan, {
        create: async (fields) => {
            const s = attach(db.id_card_scan.build({id: rows.length + 1, ...fields, createdAt: new Date()}));
            rows.push(s);
            return s;
        },
        findOne: async ({where}) => rows.find((s) => s.public_id === where.public_id && (!where.client_id || s.client_id === where.client_id)) || null,
        findAndCountAll: async ({where}) => {
            const found = rows.filter((s) => (where.labelled_at === null ? !s.labelled_at : true));
            return {rows: found, count: found.length};
        },
        count: async () => rows.length,
    });
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    stub(t, db.client, {findOne: async ({where}) => {
        const id = where.token_hash === tokenHelper.sha256('kyc_other') ? 2 : 1;
        return Object.assign(db.client.build({id, name: 'Acme Bank', status: 'active'}), {update: async () => {}});
    }});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-card-'));
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-models-'));
    process.env.ID_CARD_STORAGE_DIR = dir;
    process.env.ID_MODEL_DIR = modelDir;
    process.env.ADMIN_API_KEY = 'admin-secret';
    idModel.reload();
    t.after(() => {
        delete process.env.ID_CARD_STORAGE_DIR;
        delete process.env.ID_MODEL_DIR;
        delete process.env.ADMIN_API_KEY;
        idModel.reload();
        fs.rmSync(dir, {recursive: true, force: true});
        fs.rmSync(modelDir, {recursive: true, force: true});
    });
    return {rows, dir};
}

async function service(t) {
    const app = express();
    app.use('/api/kyc/id-card', express.json({limit: '4mb'}));
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, p, {headers = {}, body} = {}) => {
        const res = await fetch(base + p, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        const type = res.headers.get('content-type') || '';
        return {status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())};
    };
}

const client = {Authorization: 'Bearer kyc_mine'};
const admin = {'X-Admin-Key': 'admin-secret'};
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
const image = jpeg.toString('base64');

test('a card is read, kept with its OCR, and only its client can see it', async (t) => {
    const logged = [];
    stub(t, db.api_request, {create: async (r) => logged.push(r)});
    const {rows, dir} = scansTable(t);
    const call = await service(t);

    const res = await call('POST', '/api/kyc/id-card', {headers: client, body: {
        country: 'ZW', ocr: {lines: cardOcr('plastic')}, image, reference: 'cust-42', device: {sdk: 'smatid_kyc', platform: 'android'},
    }});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.scan_id, /^ic_[A-Za-z0-9_-]{32}$/);
    assert.strictEqual(res.body.status, 'passed');
    assert.strictEqual(res.body.country, 'ZW');
    assert.strictEqual(res.body.card_type, 'plastic');
    assert.strictEqual(res.body.document.id_number, idNumber());
    assert.strictEqual(res.body.document.surname, 'MOYO');
    assert.strictEqual(res.body.extracted_by, 'rules:ZW');
    assert.strictEqual(res.body.ocr, undefined, 'the OCR stays on the server');
    assert.ok(fs.existsSync(path.join(dir, `${res.body.scan_id}.jpg`)));
    assert.strictEqual(rows[0].ocr.lines.length, cardOcr('plastic').length);

    const id = res.body.scan_id;
    assert.strictEqual((await call('GET', `/api/kyc/id-card/${id}`, {headers: client})).body.document.first_names, 'TARIRO GRACE');
    assert.ok((await call('GET', `/api/kyc/id-card/${id}/image`, {headers: client})).body.equals(jpeg));
    const other = {Authorization: 'Bearer kyc_other'};
    assert.strictEqual((await call('GET', `/api/kyc/id-card/${id}`, {headers: other})).status, 404);
    assert.strictEqual((await call('GET', `/api/kyc/id-card/${id}/image`, {headers: other})).status, 404);

    await new Promise((r) => setTimeout(r, 20));
    const row = logged.find((r) => r.method === 'POST');
    assert.strictEqual(row.check_type, 'id_card');
    assert.match(row.request.body.image, /not logged/);
    assert.match(row.request.body.ocr, /not logged/);
});

test('an unreadable card is a 422 and isn\'t kept; bad input is a 400', async (t) => {
    stub(t, db.api_request, {create: async () => {}});
    const {rows} = scansTable(t);
    const call = await service(t);
    const post = (body) => call('POST', '/api/kyc/id-card', {headers: client, body});

    const unreadable = await post({country: 'ZW', ocr: {lines: [line('REPUBLIC OF ZIMBABWE', 0.2, 0.1)]}, image});
    assert.strictEqual(unreadable.status, 422);
    assert.strictEqual(unreadable.body.error, 'id_unreadable');
    assert.strictEqual(rows.length, 0);

    const unsupported = await post({country: 'ZA', ocr: {lines: cardOcr('plastic')}, image});
    assert.strictEqual(unsupported.body.error, 'unsupported_country');
    assert.deepStrictEqual(unsupported.body.supported, ['ZW']);
    assert.strictEqual((await post({ocr: {lines: cardOcr('plastic')}, image})).body.error, 'unsupported_country');
    assert.strictEqual((await post({country: 'ZW', image})).body.error, 'ocr_required');
    assert.strictEqual((await post({country: 'ZW', ocr: {lines: 'x'}, image})).body.error, 'invalid_ocr');
    assert.strictEqual((await post({country: 'ZW', ocr: {lines: cardOcr('plastic')}})).body.error, 'invalid_image');
    assert.strictEqual((await post({country: 'ZW', ocr: {lines: cardOcr('plastic')}, image, reference: ''})).body.error, 'invalid_reference');
    assert.strictEqual((await call('POST', '/api/kyc/id-card', {body: {country: 'ZW'}})).status, 401);
});

test('admins label scans; labels are normalised and checked against the country\'s fields', async (t) => {
    stub(t, db.api_request, {create: async () => {}});
    const {rows} = scansTable(t);
    const call = await service(t);
    const scan = (await call('POST', '/api/kyc/id-card', {headers: client, body: {country: 'ZW', ocr: {lines: cardOcr('metal')}, image}})).body;

    const list = await call('GET', '/api/admin/id-cards?labelled=0', {headers: admin});
    assert.strictEqual(list.body.total, 1);
    assert.strictEqual(list.body.scans[0].labelled, false);

    const shown = await call('GET', `/api/admin/id-cards/${scan.scan_id}`, {headers: admin});
    assert.strictEqual(shown.body.scan.ocr.lines.length, cardOcr('metal').length);
    assert.deepStrictEqual(shown.body.profile.card_types, ['metal', 'plastic']);

    const label = (body) => call('PUT', `/api/admin/id-cards/${scan.scan_id}/label`, {headers: admin, body});
    const saved = await label({card_type: 'metal', fields: {id_number: idNumber().replace(/[ -]/g, ''), surname: 'moyo', first_names: 'Tariro Grace', date_of_birth: '12 MAR 1990'}});
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.deepStrictEqual(rows[0].label, {card_type: 'metal', fields: {id_number: idNumber(), surname: 'MOYO', first_names: 'TARIRO GRACE', date_of_birth: '1990-03-12'}});
    assert.ok(rows[0].labelled_at);

    assert.strictEqual((await label({card_type: 'paper', fields: {id_number: idNumber()}})).body.error, 'invalid_card_type');
    assert.strictEqual((await label({fields: {id_number: idNumber(), shoe_size: '9'}})).body.error, 'unknown_field');
    assert.strictEqual((await label({fields: {id_number: idNumber(), date_of_birth: '31/02/1990'}})).body.error, 'invalid_date_of_birth');
    assert.strictEqual((await label({fields: {surname: 'MOYO'}})).body.error, 'id_number_required');
    assert.strictEqual((await call('PUT', `/api/admin/id-cards/${scan.scan_id}/label`, {body: {fields: {}}})).status, 401);

    const models = await call('GET', '/api/admin/id-models', {headers: admin});
    assert.strictEqual(models.body.countries[0].code, 'ZW');
    assert.strictEqual(models.body.countries[0].model, null);
});

test('the card\'s face is matched to a liveness check; a card with no face is recorded for review', async (t) => {
    stub(t, db.api_request, {create: async () => {}});
    const {rows} = scansTable(t);
    const livenessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
    process.env.LIVENESS_STORAGE_DIR = livenessDir;
    t.after(() => {
        delete process.env.LIVENESS_STORAGE_DIR;
        fs.rmSync(livenessDir, {recursive: true, force: true});
    });
    const liveId = 'lv_' + 'l'.repeat(32);
    fs.mkdirSync(path.join(livenessDir, liveId));
    fs.writeFileSync(path.join(livenessDir, liveId, 'attempt-1-0-center.jpg'), jpeg);
    const live = db.liveness_session.build({id: 1, public_id: liveId, client_id: 1, status: 'passed', attempts: 1, expires_at: new Date(Date.now() + 60000)});
    stub(t, db.liveness_session, {findOne: async ({where}) => (where.public_id === liveId && where.client_id === 1 ? live : null)});
    const call = await service(t);

    const scan = (await call('POST', '/api/kyc/id-card', {headers: client, body: {country: 'ZW', ocr: {lines: cardOcr('plastic')}, image}})).body;
    const match = (id = scan.scan_id) => call('POST', `/api/kyc/id-card/${id}/face-match`, {headers: client, body: {liveness_session_id: liveId}});

    stub(t, faceMatchHelper, {compare: async () => ({status: 'match', similarity: 0.71, thresholds: {match: 0.4, review: 0.25}, model: 'sface'})});
    const matched = await match();
    assert.strictEqual(matched.status, 201, JSON.stringify(matched.body));
    assert.strictEqual(matched.body.face_match.matched, true);
    assert.strictEqual(matched.body.face_match.identity_verified, true);

    faceMatchHelper.compare = async () => {
        throw new faceMatchHelper.FaceMatchError('no_face_in_passport');
    };
    const noFace = await match();
    assert.strictEqual(noFace.status, 422);
    assert.strictEqual(noFace.body.error, 'no_face_on_card');
    assert.strictEqual(rows[0].face_match.status, 'no_face_on_card');

    assert.strictEqual((await call('POST', `/api/kyc/id-card/${scan.scan_id}/face-match`, {headers: client, body: {}})).body.error, 'liveness_session_id_required');
    assert.strictEqual((await match('ic_' + 'x'.repeat(32))).status, 404);
});

// ----- Verification sessions -----

test('ID card sessions run the card, liveness and face match, and add up to an outcome', () => {
    assert.deepStrictEqual(verificationHelper.TYPES.id_card, ['id_card']);
    assert.deepStrictEqual(verificationHelper.TYPES.id_card_full, ['id_card', 'liveness', 'face_match']);

    const session = {type: 'id_card_full', skipped: {}};
    const liveness = {currentStatus: () => 'passed'};
    const steps = (idCard, scan = null) => verificationHelper.stepStatuses(session, {scan, idCard, liveness});

    assert.deepStrictEqual(steps({status: 'passed', face_match: {status: 'match'}}), {id_card: 'passed', liveness: 'passed', face_match: 'passed'});
    assert.strictEqual(verificationHelper.outcomeOf(steps({status: 'passed', face_match: {status: 'match'}})), 'verified');
    // The metal card: no surname split, no face. For a person to look at.
    const metal = steps({status: 'review', face_match: {status: 'no_face_on_card'}});
    assert.deepStrictEqual(metal, {id_card: 'review', liveness: 'passed', face_match: 'review'});
    assert.strictEqual(verificationHelper.outcomeOf(metal), 'review');
    assert.strictEqual(steps({status: 'failed'}).id_card, 'failed');
    assert.strictEqual(verificationHelper.outcomeOf(steps(null)), 'incomplete');
    // A passport's face match doesn't count for an ID card session.
    assert.strictEqual(steps({status: 'passed'}, {face_match: {status: 'match'}}).face_match, 'not_done');
});

// ----- What the OCR does to real photos -----

test('an ID number split over two OCR lines is joined; a lost check letter is worked out, for review', () => {
    const letter = zw.expectedCheckLetter('24', '3763637');
    const split = zw.rules(ocrInput.parse([line(`24-3763637 ${letter}`, 0.1, 0.2), line('29', 0.45, 0.2, 0.05), line('MOYO', 0.1, 0.4)]));
    assert.strictEqual(split.fields.id_number, `24-3763637 ${letter} 29`);
    assert.strictEqual(split.fields.id_number_letter_inferred, undefined);

    const lost = zw.rules(ocrInput.parse([line('47-6166061', 0.1, 0.2), line(') 77', 0.45, 0.2, 0.05), line('MOYO', 0.1, 0.4),
        line('TARIRO', 0.1, 0.5), line('16/10/1968', 0.1, 0.6)]));
    assert.strictEqual(lost.fields.id_number, `47-6166061 ${zw.expectedCheckLetter('47', '6166061')} 77`);
    assert.strictEqual(lost.fields.id_number_letter_inferred, true);
    const checked = zw.check(lost, {now: new Date('2026-11-11T00:00:00Z')});
    assert.strictEqual(checked.status, 'review');
    assert.strictEqual(checked.checks.id_check_letter, null);
    assert.ok(checked.review_reasons.includes('check_letter_not_read'));

    // A date is never taken for an ID number with a lost letter.
    assert.strictEqual(zw.findIdNumber(ocrInput.parse([line('16/10/1968', 0.1, 0.2), line('12', 0.4, 0.2, 0.05)])), null);
});

test('symbols OCR reads for letters are turned back into them', () => {
    const letter = zw.expectedCheckLetter('02', '5919657');
    assert.strictEqual(letter, 'P');
    assert.strictEqual(zw.parseIdNumber('02-5919657 ₽ 35').value, '02-5919657 P 35');
});

test('drawn cards train the model, but don\'t make it active on their own', () => {
    const drawn = labelledScans(90).map((s) => ({...s, source: 'synthetic'}));
    const synthOnly = idModel.train(drawn, zw);
    assert.strictEqual(synthOnly.metrics.tested_on, 'held_out_with_synthetic');
    assert.strictEqual(synthOnly.active, false);
    assert.deepStrictEqual([synthOnly.samples.real, synthOnly.samples.synthetic], [0, 90]);
    assert.strictEqual(idModel.train(drawn, zw, {activateSynthetic: true}).active, true);

    // With enough real scans, only real ones are held back to test on.
    const real = labelledScans(20);
    const mixed = idModel.train([...drawn, ...real], zw);
    assert.strictEqual(mixed.metrics.tested_on, 'held_out');
    assert.strictEqual(mixed.samples.test, 4);
    assert.strictEqual(mixed.samples.train, 106);
});

test('drawn cards are loaded from the generator\'s labels and the OCR of their pictures', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const label = {card_type: 'metal', fields: {id_number: idNumber(), surname: 'MOYO'}};
    fs.writeFileSync(path.join(dir, 'labels.jsonl'), [
        {image: 'images/a.jpg', country: 'ZW', label},
        {image: 'images/b.jpg', country: 'ZW', label},
    ].map((r) => JSON.stringify(r)).join('\n'));
    fs.writeFileSync(path.join(dir, 'ocr.jsonl'), [
        {image: 'images/a.jpg', ocr: {lines: cardOcr('metal')}},
        {image: 'images/b.jpg', ocr: {lines: []}},
    ].map((r) => JSON.stringify(r)).join('\n'));
    const {samples, unread} = require('../helpers/idcard/synthetic').load(dir, 'ZW');
    assert.strictEqual(samples.length, 1);
    assert.strictEqual(unread, 1);
    assert.strictEqual(samples[0].source, 'synthetic');
    assert.deepStrictEqual(samples[0].label, label);
});

test('a real-style plastic card: labels on the left, Cyrillic look-alikes, misread labels, and "CIT F" after the number', () => {
    // A made-up person, laid out and misread the way real plastic cards come back from OCR.
    const serial = Array.from({length: 23}, (_, i) => String(142000 + i)).find((s) => zw.expectedCheckLetter('49', s) === 'T');
    const lines = ocrInput.parse([
        line('REPUBLIC OF ZIMBABWE', 0.33, 0.15), line('NATIONAL REGISTRATION', 0.29, 0.19, 0.4),
        // Cyrillic Т and С, as OCR returned them.
        line('ID Nussen', 0.31, 0.28, 0.12), line(`49- ${serial} Т 48 СIT F`, 0.51, 0.27, 0.37),
        line('SURNAME', 0.31, 0.33, 0.1), line('MOYO', 0.51, 0.32, 0.27),
        line('FIRST NAME', 0.31, 0.38, 0.13), line('TARIRO GRACE', 0.51, 0.37, 0.39),
        line('DATE oF BiRTH', 0.31, 0.43, 0.16), line('06/02/1999', 0.51, 0.42, 0.19),
        line('VILLAGE OF ORION', 0.31, 0.49, 0.2), line('CHIKOMBA', 0.52, 0.47, 0.17),
        line('PLACE OF BATH', 0.31, 0.54, 0.17), line('MUDZI', 0.51, 0.52, 0.12),
        line('DATE OF ISSUE', 0.31, 0.6, 0.15), line('07/09/2018', 0.51, 0.58, 0.19),
        line('Signature et hel', 0.31, 0.65, 0.18),
    ]);
    const read = zw.rules(lines);
    assert.deepStrictEqual(read.fields, {
        id_number: `49-${serial} T 48`, surname: 'MOYO', first_names: 'TARIRO GRACE', date_of_birth: '1999-02-06',
        village_of_origin: 'CHIKOMBA', place_of_birth: 'MUDZI', date_of_issue: '2018-09-07', sex: 'F', citizenship: 'CIT',
    });
    const checked = zw.check(read, {now: new Date('2026-11-11T00:00:00Z')});
    assert.strictEqual(checked.status, 'passed');
    assert.strictEqual(checked.document.citizenship, 'CIT');
});

test('labels OCR misreads ("FIRST NANE", "VLLAGE") still count, and a date read above its label is still the date of issue', () => {
    // A made-up person, as the phone's OCR read a real plastic card.
    const id = idNumber('63', '204782', '13');
    const read = zw.rules(ocrInput.parse([
        line('REPUBLIC OF ZIMBABWE', 0.3, 0.02), line('NATIONAL REGISTRATION', 0.3, 0.08), line('ID NUMBER', 0.33, 0.2, 0.12),
        line(`${id} CIT`, 0.55, 0.2, 0.3), line('SURNAME', 0.33, 0.27, 0.1), line('MOYO', 0.55, 0.27, 0.2),
        line('FIRST NANE', 0.33, 0.34, 0.1), line('TARIRO', 0.55, 0.34, 0.2), line('DATE OF BIRTH', 0.33, 0.41, 0.12), line('15/06/1995', 0.55, 0.41, 0.2),
        line('VLLAGE OF ORIGIN', 0.33, 0.48, 0.14), line('CHIKOMBA', 0.55, 0.48, 0.2), line('PLACE OF BIRTH', 0.33, 0.55, 0.12), line('HARARE', 0.55, 0.55, 0.2),
        // The date sits a little higher than its label, so OCR gives it first.
        line('11/11/2014', 0.55, 0.615, 0.2), line('DATE OF ISSUE', 0.33, 0.625, 0.12), line('Signature of Holder', 0.33, 0.7, 0.2),
    ]));
    assert.deepStrictEqual(read.fields, {
        id_number: id, surname: 'MOYO', first_names: 'TARIRO', date_of_birth: '1995-06-15', village_of_origin: 'CHIKOMBA',
        place_of_birth: 'HARARE', date_of_issue: '2014-11-11',
    });
    assert.strictEqual(zw.check(read, {now: new Date('2026-11-12T00:00:00Z')}).status, 'passed');
    // Too garbled to be a label: left alone.
    assert.strictEqual(zw.labelOf('ViaGE F CRGN'), null);
});
