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
const requestLog = require('../helpers/requestLogHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

const NOW = new Date('2026-11-06T10:00:00Z');

/** Builds a valid TD3 MRZ, with correct check digits, from the parts. */
function mrz({country = 'ZWE', surname = 'MOYO', given = 'TARIRO<GRACE', number = 'FN1234567', nationality = 'ZWE',
    birth = '900312', sex = 'F', expiry = '310101', optional = ''} = {}) {
    const pad = (s, n) => (s + '<'.repeat(n)).slice(0, n);
    const cd = mrzHelper.checkDigit;
    const l1 = pad(`P<${country}${surname}<<${given}`, 44);
    const num = pad(number, 9);
    const opt = pad(optional, 14);
    const optCheck = /^<*$/.test(opt) ? '<' : cd(opt);
    const body = `${num}${cd(num)}${nationality}${birth}${cd(birth)}${sex}${expiry}${cd(expiry)}${opt}${optCheck}`;
    const composite = `${num}${cd(num)}${birth}${cd(birth)}${expiry}${cd(expiry)}${opt}${optCheck}`;
    return [l1, body + cd(composite)];
}

// ----- Reading the MRZ -----

test('check digits follow ICAO 9303', () => {
    // From the ICAO 9303 specimen passport.
    assert.strictEqual(mrzHelper.checkDigit('L898902C3'), '6');
    assert.strictEqual(mrzHelper.checkDigit('740812'), '2');
    assert.strictEqual(mrzHelper.checkDigit('120415'), '9');
    assert.strictEqual(mrzHelper.checkDigit('ZE184226B<<<<<'), '1');
});

test('the ICAO specimen reads, and is expired', () => {
    const r = mrzHelper.parse([
        'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
        'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    ], {now: NOW});
    assert.strictEqual(r.valid, true, r.problems.join());
    assert.deepStrictEqual(r.fields, {
        document_type: 'P', issuing_country: 'UTO', surname: 'ERIKSSON', given_names: 'ANNA MARIA', name_truncated: false,
        document_number: 'L898902C3', nationality: 'UTO', birth_date: '1974-08-12', birth_date_partial: false, sex: 'F',
        expiry_date: '2012-04-15', expired: true, personal_number: 'ZE184226B',
    });
});

test('a Zimbabwean passport reads, with an empty personal number', () => {
    const r = mrzHelper.parse(mrz(), {now: NOW});
    assert.strictEqual(r.valid, true, r.problems.join());
    assert.strictEqual(r.fields.surname, 'MOYO');
    assert.strictEqual(r.fields.given_names, 'TARIRO GRACE');
    assert.strictEqual(r.fields.birth_date, '1990-03-12');
    assert.strictEqual(r.fields.expiry_date, '2031-01-01');
    assert.strictEqual(r.fields.expired, false);
    assert.strictEqual(r.fields.personal_number, null);
    assert.deepStrictEqual(Object.values(r.checks), [true, true, true, true, true]);
});

test('birth years in the future belong to the last century', () => {
    assert.strictEqual(mrzHelper.toDate('300101', 'birth', NOW), '1930-01-01');
    assert.strictEqual(mrzHelper.toDate('050101', 'birth', NOW), '2005-01-01');
    assert.strictEqual(mrzHelper.toDate('360101', 'expiry', NOW), '2036-01-01');
    assert.strictEqual(mrzHelper.toDate('901332', 'birth', NOW), null, 'no 13th month');
});

test('a birth date with unknown parts is read as far as it is known', () => {
    // ICAO 9303 fills unknown parts with "<"; some countries use "X". The check digit covers them either way.
    const cases = [
        ['9003<<', '1990-03'],
        ['90XX<<', '1990'],
        ['90<<<<', '1990'],
        ['XXXXXX', null],
        ['<<<<<<', null],
        ['90<<15', '1990'],
    ];
    for (const [birth, expected] of cases) {
        const r = mrzHelper.parse(mrz({birth}), {now: NOW});
        assert.strictEqual(r.valid, true, `${birth}: ${r.problems.join()}`);
        assert.strictEqual(r.fields.birth_date, expected, birth);
        assert.strictEqual(r.fields.birth_date_partial, true, birth);
        assert.strictEqual(r.checks.birth_date, true, birth);
    }
    assert.strictEqual(mrzHelper.parse(mrz(), {now: NOW}).fields.birth_date_partial, false);

    // Still strict: a half-filled part, an impossible date, or a wrong check digit is refused.
    for (const birth of ['9<0312', '9013<<', '9002<<'.replace('02', '00'), '900230']) {
        assert.ok(mrzHelper.parse(mrz({birth}), {now: NOW}).problems.includes('birth_date_invalid'), birth);
    }
    const [l1, l2] = mrz({birth: '9003<<'});
    const tampered = mrzHelper.parse([l1, l2.slice(0, 13) + '9004<<' + l2.slice(19)], {now: NOW});
    assert.ok(tampered.problems.includes('birth_date_check_failed'));
    // An unknown birth date doesn't make expiry dates any less strict.
    assert.ok(mrzHelper.parse(mrz({expiry: '31<<<<'}), {now: NOW}).problems.includes('expiry_date_invalid'));
});

test('the usual OCR mix-ups are fixed where only digits or letters may be', () => {
    const [l1, l2] = mrz();
    // Spaces, lower case, «, and O/0, I/1, S/5 swapped in the dates, check digits and names.
    const messy = [
        l1.replace('MOYO', 'M0Y0').replace(/</g, (c, i) => (i > 30 ? '«' : c)).toLowerCase(),
        l2.slice(0, 13) + l2.slice(13, 19).replace(/0/g, 'O').replace(/1/g, 'I') + l2.slice(19, 30).replace(/</g, ' <') + l2.slice(30),
    ];
    const r = mrzHelper.parse(messy, {now: NOW});
    assert.strictEqual(r.valid, true, r.problems.join());
    assert.strictEqual(r.fields.surname, 'MOYO');
    assert.strictEqual(r.fields.birth_date, '1990-03-12');
    assert.deepStrictEqual(r.lines, mrz());
});

test('the MRZ is found inside everything read off the page', () => {
    const text = ['REPUBLIC OF ZIMBABWE', 'PASSPORT', 'Surname MOYO', ...mrz(), ''].join('\n');
    assert.strictEqual(mrzHelper.parse(text, {now: NOW}).valid, true);
});

test('a misread or tampered line fails its check digit', () => {
    const [l1, l2] = mrz();
    const wrongNumber = mrzHelper.parse([l1, 'FN1234568' + l2.slice(9)], {now: NOW});
    assert.strictEqual(wrongNumber.valid, false);
    assert.ok(wrongNumber.problems.includes('document_number_check_failed'));
    assert.ok(wrongNumber.problems.includes('composite_check_failed'));

    const wrongBirth = mrzHelper.parse([l1, l2.slice(0, 13) + '900313' + l2.slice(19)], {now: NOW});
    assert.ok(wrongBirth.problems.includes('birth_date_check_failed'));

    assert.deepStrictEqual(mrzHelper.parse(['hello', 'world']).problems, ['mrz_not_found']);
    assert.deepStrictEqual(mrzHelper.parse(null).problems, ['mrz_not_found']);
    // An ID card's MRZ isn't a passport's.
    assert.ok(mrzHelper.parse(['I<' + l1.slice(2), l2]).problems.includes('mrz_not_found'));
});

// ----- The endpoint, with an in-memory scans table -----

function scansTable(t) {
    const rows = [];
    stub(t, db.passport_scan, {
        create: async (fields) => {
            const s = db.passport_scan.build({id: rows.length + 1, ...fields, createdAt: new Date()});
            rows.push(s);
            return s;
        },
        findOne: async ({where}) => rows.find((s) => s.public_id === where.public_id && (!where.client_id || s.client_id === where.client_id)) || null,
    });
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    stub(t, db.client, {findOne: async ({where}) => {
        const id = where.token_hash === tokenHelper.sha256('kyc_other') ? 2 : 1;
        return Object.assign(db.client.build({id, name: 'Acme Bank', status: 'active'}), {update: async () => {}});
    }});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-'));
    process.env.PASSPORT_STORAGE_DIR = dir;
    t.after(() => {
        delete process.env.PASSPORT_STORAGE_DIR;
        fs.rmSync(dir, {recursive: true, force: true});
    });
    return {rows, dir};
}

async function service(t) {
    const app = express();
    app.use('/api/kyc/passport', express.json({limit: '4mb'}));
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, p, {headers = {}, body} = {}) => {
        const res = await fetch(base + p, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        const type = res.headers.get('content-type') || '';
        return {status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers};
    };
}

const client = {Authorization: 'Bearer kyc_mine'};
// Enough of a JPEG for the server: the FF D8 FF start, and a believable size.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
const image = jpeg.toString('base64');

test('a scan is read, kept, and only its client can see it and its picture', async (t) => {
    const logged = [];
    stub(t, db.api_request, {create: async (r) => logged.push(r)});
    const {dir} = scansTable(t);
    const call = await service(t);

    const res = await call('POST', '/api/kyc/passport', {headers: client, body: {
        mrz: mrz(), image: `data:image/jpeg;base64,${image}`, reference: 'cust-42',
        device: {sdk: 'smatid_kyc', sdk_version: '0.1.0', platform: 'android', scan_ms: 2300, password: 'x'},
    }});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.scan_id, /^ps_[A-Za-z0-9_-]{32}$/);
    assert.strictEqual(res.body.status, 'passed');
    assert.strictEqual(res.body.passed, true);
    assert.strictEqual(res.body.reference, 'cust-42');
    assert.strictEqual(res.body.document.document_number, 'FN1234567');
    assert.strictEqual(res.body.document.surname, 'MOYO');
    assert.strictEqual(res.body.has_image, true);
    assert.ok(fs.existsSync(path.join(dir, `${res.body.scan_id}.jpg`)));

    const id = res.body.scan_id;
    assert.strictEqual((await call('GET', `/api/kyc/passport/${id}`, {headers: client})).body.document.given_names, 'TARIRO GRACE');
    const picture = await call('GET', `/api/kyc/passport/${id}/image`, {headers: client});
    assert.strictEqual(picture.status, 200);
    assert.ok(picture.body.equals(jpeg));
    // Another client can't.
    const other = {Authorization: 'Bearer kyc_other'};
    assert.strictEqual((await call('GET', `/api/kyc/passport/${id}`, {headers: other})).status, 404);
    assert.strictEqual((await call('GET', `/api/kyc/passport/${id}/image`, {headers: other})).status, 404);
    // Nor anyone without a token.
    assert.strictEqual((await call('POST', '/api/kyc/passport', {body: {mrz: mrz(), image}})).status, 401);

    // The picture isn't kept in the request log.
    await new Promise((r) => setTimeout(r, 20));
    const row = logged.find((r) => r.method === 'POST');
    assert.strictEqual(row.check_type, 'passport');
    assert.match(row.request.body.image, /not logged/);
    assert.deepStrictEqual(row.request.body.mrz, mrz());
});

test('a misread is refused with 422, an expired passport is a failed scan, and bad input is a 400', async (t) => {
    stub(t, db.api_request, {create: async () => {}});
    const {rows} = scansTable(t);
    const call = await service(t);

    const [l1, l2] = mrz();
    const misread = await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: [l1, 'FN1234568' + l2.slice(9)], image}});
    assert.strictEqual(misread.status, 422);
    assert.strictEqual(misread.body.error, 'mrz_unreadable');
    assert.ok(misread.body.problems.includes('document_number_check_failed'));
    assert.strictEqual(rows.length, 0, 'nothing kept');

    const expired = await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: mrz({expiry: '240101'}), image}});
    assert.strictEqual(expired.status, 201);
    assert.strictEqual(expired.body.status, 'failed');
    assert.strictEqual(expired.body.failure_reason, 'document_expired');
    assert.strictEqual(expired.body.document.expired, true);

    assert.strictEqual((await call('POST', '/api/kyc/passport', {headers: client, body: {image}})).body.error, 'mrz_required');
    assert.strictEqual((await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: mrz()}})).body.error, 'invalid_image');
    assert.strictEqual((await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: mrz(), image: Buffer.from('GIF89a' + 'x'.repeat(2000)).toString('base64')}})).body.error, 'invalid_image');
    assert.strictEqual((await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: mrz(), image, reference: ''}})).body.error, 'invalid_reference');
});

test('the scan endpoint is refused while the module is off', async (t) => {
    stub(t, db.api_request, {create: async () => {}});
    scansTable(t);
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'disabled'})});
    const call = await service(t);
    const res = await call('POST', '/api/kyc/passport', {headers: client, body: {mrz: mrz(), image}});
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, {error: 'module_disabled', module: 'passport-check'});
});

test('the request log keeps a picture out but says how big it was', () => {
    const req = {body: {mrz: ['a', 'b'], image: 'A'.repeat(4096)}, params: {}, query: {}, method: 'POST', originalUrl: '/x', client: {id: 1}, ip: '1'};
    const res = {json: () => {}, on: (e, fn) => (res.finish = fn), statusCode: 201, locals: {}};
    let row;
    const original = db.api_request.create;
    db.api_request.create = async (r) => (row = r);
    try {
        requestLog.log('passport', {redact: ['image']})(req, res, () => {});
        res.finish();
    } finally {
        db.api_request.create = original;
    }
    assert.strictEqual(row.request.body.image, '[3 KB, not logged]');
    assert.strictEqual(req.body.image.length, 4096, 'the request itself is untouched');
});
