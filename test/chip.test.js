const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const mrzHelper = require('../helpers/passport/mrzHelper');
const chipHelper = require('../helpers/passport/chipHelper');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

// ----- A tiny DER writer, to make passports the way an issuing country does -----

function len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
    const value = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
    const t = tag > 0xff ? Buffer.from([tag >> 8, tag & 0xff]) : Buffer.from([tag]);
    return Buffer.concat([t, len(value.length), value]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octet = (b) => tlv(0x04, b);
const int = (n) => {
    const bytes = [];
    do {
        bytes.unshift(n & 0xff);
        n >>= 8;
    } while (n > 0);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return tlv(0x02, Buffer.from(bytes));
};
function oid(dotted) {
    const parts = dotted.split('.').map(Number);
    const out = [parts[0] * 40 + parts[1]];
    for (const p of parts.slice(2)) {
        const chunk = [p & 0x7f];
        let n = p >> 7;
        while (n > 0) {
            chunk.unshift((n & 0x7f) | 0x80);
            n >>= 7;
        }
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}
const NULL = Buffer.from([0x05, 0x00]);
const utc = (d) => tlv(0x17, d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z');
const name = (country, cn) => seq(set(seq(oid('2.5.4.6'), tlv(0x13, country))), set(seq(oid('2.5.4.3'), tlv(0x0c, cn))));

// Key types: how to sign, and the algorithm identifiers.
const KINDS = {
    rsa: {
        gen: () => crypto.generateKeyPairSync('rsa', {modulusLength: 2048}),
        sigAlg: seq(oid('1.2.840.113549.1.1.11'), NULL),
        sign: (data, key) => crypto.sign('sha256', data, key),
    },
    ec: {
        gen: () => crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'}),
        sigAlg: seq(oid('1.2.840.10045.4.3.2')),
        sign: (data, key) => crypto.sign('sha256', data, key),
    },
    // Brainpool with BSI "plain" (r || s) signatures, as German passports use.
    brainpool: {
        gen: () => crypto.generateKeyPairSync('ec', {namedCurve: 'brainpoolP256r1'}),
        sigAlg: seq(oid('0.4.0.127.0.7.1.1.4.1.3')),
        sign: (data, key) => crypto.sign('sha256', data, {key, dsaEncoding: 'ieee-p1363'}),
    },
};

/** A v3 certificate for `subjectKey`, signed by `issuerKey`. */
function certificate({serial, issuer, subject, subjectKey, issuerKey, kind, ca = false, from, to}) {
    const ext = ca ? [tlv(0xa3, seq(seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octet(seq(tlv(0x01, Buffer.from([0xff])))))))] : [];
    // Certificates themselves always use ordinary (DER) ECDSA; only EF.SOD may use the plain form.
    const certAlg = kind === 'rsa' ? KINDS.rsa.sigAlg : seq(oid('1.2.840.10045.4.3.2'));
    const tbs = seq(
        tlv(0xa0, int(2)), int(serial), certAlg, issuer, seq(utc(from), utc(to)), subject,
        subjectKey.export({type: 'spki', format: 'der'}), ...ext,
    );
    const sig = crypto.sign('sha256', tbs, issuerKey);
    return seq(tbs, certAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

const NOW = new Date('2026-11-06T10:00:00Z');
const years = (n) => new Date(NOW.getTime() + n * 365 * 86400000);

/** A country (CSCA) and one of its document signers. */
function country(kind = 'rsa', code = 'ZW') {
    const csca = KINDS[kind].gen();
    const ds = KINDS[kind].gen();
    const cscaName = name(code, `CSCA ${code}`);
    const cscaCert = certificate({serial: 1, issuer: cscaName, subject: cscaName, subjectKey: csca.publicKey, issuerKey: csca.privateKey, kind, ca: true, from: years(-5), to: years(10)});
    const dsCert = certificate({serial: 7, issuer: cscaName, subject: name(code, `DS ${code}`), subjectKey: ds.publicKey, issuerKey: csca.privateKey, kind, from: years(-1), to: years(9)});
    return {kind, cscaCert, dsCert, dsKey: ds.privateKey};
}

function mrzLines({birth = '900312', expiry = '310101', number = 'FN1234567'} = {}) {
    const cd = mrzHelper.checkDigit;
    const pad = (s, n) => (s + '<'.repeat(n)).slice(0, n);
    const num = pad(number, 9);
    const body = `${num}${cd(num)}ZWE${birth}${cd(birth)}F${expiry}${cd(expiry)}${'<'.repeat(14)}<`;
    const comp = `${num}${cd(num)}${birth}${cd(birth)}${expiry}${cd(expiry)}${'<'.repeat(14)}<`;
    return [pad('P<ZWEMOYO<<TARIRO<GRACE', 44), body + cd(comp)];
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 9), Buffer.from([0xff, 0xd9])]);
const dg1For = (lines) => tlv(0x61, tlv(0x5f1f, lines.join('')));
const dg2For = (jpeg = JPEG) => tlv(0x75, tlv(0x7f61, int(1), tlv(0x7f60, tlv(0xa1, tlv(0x80, Buffer.from([1, 1]))),
    tlv(0x5f2e, Buffer.concat([Buffer.from('FAC\0010\0'), Buffer.alloc(24, 0), jpeg])))));

/** EF.SOD for these data groups, signed by `who`'s document signer. */
function sodFor(who, groups, {tamperSignature = false} = {}) {
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
    const lds = seq(int(0), seq(oid('2.16.840.1.101.3.4.2.1')),
        seq(...Object.entries(groups).map(([n, bytes]) => seq(int(Number(n)), octet(sha256(bytes))))));
    const attrs = [
        seq(oid('1.2.840.113549.1.9.3'), set(oid('2.23.136.1.1.1'))),
        seq(oid('1.2.840.113549.1.9.4'), set(octet(sha256(lds)))),
    ];
    const signedSet = set(...attrs);
    let signature = KINDS[who.kind].sign(signedSet, who.dsKey);
    if (tamperSignature) signature = Buffer.from(signature.map((b, i) => (i === 10 ? b ^ 1 : b)));
    const signerInfo = seq(int(1), seq(name('ZW', 'CSCA ZW'), int(7)), seq(oid('2.16.840.1.101.3.4.2.1')),
        tlv(0xa0, ...attrs), who.kind === 'rsa' ? KINDS.rsa.sigAlg : KINDS[who.kind].sigAlg, octet(signature));
    const signedData = seq(int(3), set(seq(oid('2.16.840.1.101.3.4.2.1'))),
        seq(oid('2.23.136.1.1.1'), tlv(0xa0, octet(lds))), tlv(0xa0, who.dsCert), set(signerInfo));
    return tlv(0x77, seq(oid('1.2.840.113549.1.7.2'), tlv(0xa0, signedData)));
}

/** A whole chip: DG1, DG2 and EF.SOD over them. */
function chip(who, {lines = mrzLines(), ...opts} = {}) {
    const dg1 = dg1For(lines);
    const dg2 = dg2For();
    return {dg1, dg2, sod: sodFor(who, {1: dg1, 2: dg2}, opts)};
}

/** A CSCA store holding these certificates, for the length of the test. */
function cscaStore(t, ...certs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csca-'));
    certs.forEach((c, i) => fs.writeFileSync(path.join(dir, `csca-${i}.der`), c));
    process.env.CSCA_DIR = dir;
    chipHelper.loadStore({reload: true});
    t.after(() => {
        delete process.env.CSCA_DIR;
        fs.rmSync(dir, {recursive: true, force: true});
        chipHelper.loadStore({reload: true});
    });
}

const scanFields = () => mrzHelper.parse(mrzLines(), {now: NOW}).fields;

// ----- The checks -----

for (const kind of ['rsa', 'ec', 'brainpool']) {
    test(`a genuine chip is verified (${kind})`, (t) => {
        const zw = country(kind);
        cscaStore(t, zw.cscaCert);
        const r = chipHelper.verify(chip(zw), {scanFields: scanFields(), now: NOW});
        assert.strictEqual(r.status, 'verified', r.problems.join());
        assert.deepStrictEqual(r.checks, {data_intact: true, signature_valid: true, issuer_trusted: true, matches_scan: true, signer_certificate_current: true});
        assert.strictEqual(r.document.document_number, 'FN1234567');
        assert.strictEqual(r.signer.country, 'ZW');
        assert.match(r.csca.subject, /CSCA ZW/);
        assert.deepStrictEqual(r.photo, {format: 'jpeg', bytes: JPEG.length});
        assert.ok(r._photo.data.equals(JPEG), 'the face picture is cut out of DG2 exactly');
        assert.strictEqual(r.clone_check, 'not_done');
    });
}

test('a changed data group, or a changed signature, fails', (t) => {
    const zw = country('ec');
    cscaStore(t, zw.cscaCert);
    const good = chip(zw);

    // Someone rewrites the name in DG1 but can't re-sign.
    const forged = dg1For(mrzLines({number: 'XX9999999'}));
    const r1 = chipHelper.verify({...good, dg1: forged}, {now: NOW});
    assert.strictEqual(r1.status, 'failed');
    assert.strictEqual(r1.checks.data_intact, false);
    assert.ok(r1.problems.includes('dg1_hash_mismatch'));

    const swappedPhoto = chipHelper.verify({...good, dg2: dg2For(Buffer.concat([JPEG, Buffer.from([1])]))}, {now: NOW});
    assert.ok(swappedPhoto.problems.includes('dg2_hash_mismatch'));

    const badSig = chipHelper.verify(chip(zw, {tamperSignature: true}), {now: NOW});
    assert.strictEqual(badSig.checks.signature_valid, false);
    assert.strictEqual(badSig.status, 'failed');
});

test('a signer from a fake CSCA fails, and a country we have no CSCA for is unverified', (t) => {
    const real = country('rsa');
    const fake = country('rsa'); // also says C=ZW, but its own keys
    cscaStore(t, real.cscaCert);
    const r = chipHelper.verify(chip(fake), {now: NOW});
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.checks.issuer_trusted, false);
    assert.ok(r.problems.includes('signer_not_issued_by_csca'));

    const za = country('rsa', 'ZA');
    const u = chipHelper.verify(chip(za), {now: NOW});
    assert.strictEqual(u.status, 'unverified');
    assert.strictEqual(u.checks.issuer_trusted, null);
    assert.strictEqual(u.checks.signature_valid, true);
    assert.ok(u.problems.includes('no_csca_for_country'));
});

test('a chip from a different passport than the scan fails', (t) => {
    const zw = country('ec');
    cscaStore(t, zw.cscaCert);
    const other = chip(zw, {lines: mrzLines({number: 'FN7654321'})});
    const r = chipHelper.verify(other, {scanFields: scanFields(), now: NOW});
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.checks.matches_scan, false);
    assert.deepStrictEqual(r.differences, ['document_number']);
});

test('a name the camera misread is corrected from the chip, not held against it', (t) => {
    const zw = country('ec');
    cscaStore(t, zw.cscaCert);
    // What happened on a real Zimbabwean passport: the "<" after the given names was read as "K".
    const misread = {...scanFields(), given_names: 'TARIRO GRACEK'};
    const r = chipHelper.verify(chip(zw), {scanFields: misread, now: NOW});
    assert.strictEqual(r.status, 'verified', r.problems.join());
    assert.strictEqual(r.checks.matches_scan, true);
    assert.deepStrictEqual(r.scan_corrections, [{field: 'given_names', scan: 'TARIRO GRACEK', chip: 'TARIRO GRACE'}]);
    assert.strictEqual(r.document.given_names, 'TARIRO GRACE');
});

test('broken chip data is refused, not guessed at', () => {
    assert.throws(() => chipHelper.verify({dg1: Buffer.from([1])}), {code: 'chip_data_invalid'});
    assert.throws(() => chipHelper.verify({sod: Buffer.from([0x77, 0x02, 0x30, 0x00]), dg1: Buffer.from([0x61, 0])}), {code: 'chip_data_invalid'});
    assert.throws(() => chipHelper.parseDg1(tlv(0x61, tlv(0x5f1f, 'TOO SHORT'))), {code: 'chip_data_invalid'});
});

test('a CSCA master list is read like the BSI one', () => {
    const zw = country('rsa');
    const ml = seq(oid('1.2.840.113549.1.7.2'), tlv(0xa0, seq(int(3), set(), seq(oid('2.23.136.1.1.2'),
        tlv(0xa0, octet(seq(int(0), set(zw.cscaCert))))), set())));
    const certs = chipHelper.masterListCerts(ml);
    assert.strictEqual(certs.length, 1);
    assert.match(new crypto.X509Certificate(certs[0]).subject, /CSCA ZW/);
});

test('the BSI master list in config/csca loads and covers Zimbabwe', () => {
    const store = chipHelper.loadStore({reload: true});
    const zw = store.certs.filter((c) => /(^|\n)C=ZW/i.test(c.subject));
    assert.ok(store.certs.length > 100, `${store.certs.length} certificates`);
    assert.ok(zw.length >= 1, 'a Zimbabwean CSCA');
});

// ----- Chip photos in JPEG 2000 -----

const photoHelper = require('../helpers/passport/photoHelper');
const jpegJs = require('jpeg-js');

/** A 64x64 JPEG 2000 codestream: red 200, green rising left to right, blue 50. */
async function j2kCodestream() {
    const factory = require('@cornerstonejs/codec-openjpeg/wasmjs');
    const lib = await (typeof factory === 'function' ? factory : factory.default)({print() {}, printErr() {}});
    const enc = new lib.J2KEncoder();
    const px = enc.getDecodedBuffer({width: 64, height: 64, bitsPerSample: 8, componentCount: 3, isSigned: false});
    for (let i = 0; i < 64 * 64; i++) [px[i * 3], px[i * 3 + 1], px[i * 3 + 2]] = [200, (i % 64) * 4, 50];
    enc.encode();
    const out = Buffer.from(enc.getEncodedBuffer());
    enc.delete();
    return out;
}

/** The codestream in a JP2 file, the way passports store it: signature, ftyp, jp2h (ihdr + colr sRGB), jp2c. */
function jp2File(codestream) {
    const box = (type, body) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(8 + body.length);
        head.write(type, 4, 'latin1');
        return Buffer.concat([head, body]);
    };
    const ihdr = Buffer.alloc(14);
    ihdr.writeUInt32BE(64, 0);
    ihdr.writeUInt32BE(64, 4);
    ihdr.writeUInt16BE(3, 8);
    ihdr[10] = 7; // 8 bits
    ihdr[11] = 7; // JPEG 2000 compression
    const colr = Buffer.from([1, 0, 0, 0, 0, 0, 16]); // enumerated, sRGB
    return Buffer.concat([
        box('jP  ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a])),
        box('ftyp', Buffer.concat([Buffer.from('jp2 '), Buffer.alloc(4), Buffer.from('jp2 ')])),
        box('jp2h', Buffer.concat([box('ihdr', ihdr), box('colr', colr)])),
        box('jp2c', codestream),
    ]);
}

const pixel = (jpg, x, y) => {
    const img = jpegJs.decode(jpg);
    const o = (y * img.width + x) * 4;
    return [...img.data.subarray(o, o + 3)];
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 4);

test('a JPEG 2000 chip photo is turned into a JPEG with the right colours', async () => {
    const codestream = await j2kCodestream();
    for (const input of [jp2File(codestream), codestream]) {
        const r = await photoHelper.toJpeg({format: 'jp2', data: input});
        assert.strictEqual(r.converted, true, r.error);
        assert.deepStrictEqual([r.width, r.height], [64, 64]);
        assert.deepStrictEqual(photoHelper.jpegSize(r.jpeg), {width: 64, height: 64});
        assert.ok(near(pixel(r.jpeg, 0, 10), [200, 0, 50]), `${pixel(r.jpeg, 0, 10)}`);
        assert.ok(near(pixel(r.jpeg, 60, 10), [200, 240, 50]), `${pixel(r.jpeg, 60, 10)}`);
    }
    // A JPEG stays as it is.
    const same = await photoHelper.toJpeg({format: 'jpeg', data: JPEG});
    assert.strictEqual(same.converted, false);
    assert.ok(same.jpeg.equals(JPEG));
    // A broken one says so instead of throwing.
    const broken = await photoHelper.toJpeg({format: 'jp2', data: jp2File(Buffer.from([0xff, 0x4f, 0xff, 0x51, 1, 2, 3]))});
    assert.ok(broken.error);
});

// ----- The endpoint -----

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
        return {status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())};
    };
}

test('the chip endpoint serves a JPEG 2000 photo as JPEG, keeping the original', async (t) => {
    const zw = country('ec');
    cscaStore(t, zw.cscaCert);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-'));
    process.env.PASSPORT_STORAGE_DIR = storage;
    t.after(() => {
        delete process.env.PASSPORT_STORAGE_DIR;
        fs.rmSync(storage, {recursive: true, force: true});
    });
    const scan = db.passport_scan.build({id: 1, public_id: 'ps_' + 'b'.repeat(32), client_id: 1, status: 'passed', document: scanFields(), createdAt: new Date()});
    scan.update = async (c) => Object.assign(scan, c);
    stub(t, db.passport_scan, {findOne: async ({where}) => (where.public_id === scan.public_id ? scan : null)});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    stub(t, db.api_request, {create: async () => {}});
    stub(t, db.client, {findOne: async () => Object.assign(db.client.build({id: 1, name: 'Acme', status: 'active'}), {update: async () => {}})});
    const call = await service(t);
    const auth = {Authorization: 'Bearer kyc_mine'};

    const jp2 = jp2File(await j2kCodestream());
    const dg1 = dg1For(mrzLines());
    const dg2 = dg2For(jp2);
    const sod = sodFor(zw, {1: dg1, 2: dg2});
    const res = await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: auth, body: {
        files: {sod: sod.toString('base64'), dg1: dg1.toString('base64'), dg2: dg2.toString('base64')},
    }});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.chip.status, 'verified');
    assert.deepStrictEqual(res.body.chip.photo, {format: 'jpeg', original_format: 'jp2', width: 64, height: 64, bytes: res.body.chip.photo.bytes});
    assert.ok(fs.readFileSync(path.join(storage, scan.public_id, 'chip-photo-original.jp2')).equals(jp2), 'the original is kept');

    const photo = await call('GET', `/api/kyc/passport/${scan.public_id}/chip/photo`, {headers: auth});
    assert.strictEqual(photo.status, 200);
    assert.deepStrictEqual(photoHelper.jpegSize(photo.body), {width: 64, height: 64});
    assert.ok(near(pixel(photo.body, 60, 10), [200, 240, 50]));
});

test('the app sends the chip for its scan; the result is kept with the scan', async (t) => {
    const zw = country('ec');
    cscaStore(t, zw.cscaCert);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-'));
    process.env.PASSPORT_STORAGE_DIR = storage;
    t.after(() => {
        delete process.env.PASSPORT_STORAGE_DIR;
        fs.rmSync(storage, {recursive: true, force: true});
    });

    const scan = db.passport_scan.build({id: 1, public_id: 'ps_' + 'a'.repeat(32), client_id: 1, status: 'passed', document: scanFields(), createdAt: new Date()});
    scan.update = async (c) => Object.assign(scan, c);
    stub(t, db.passport_scan, {findOne: async ({where}) => (where.public_id === scan.public_id && where.client_id !== 2 ? scan : null)});
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: 0})});
    const logged = [];
    stub(t, db.api_request, {create: async (r) => logged.push(r)});
    stub(t, db.client, {findOne: async ({where}) => Object.assign(db.client.build({id: where.token_hash === tokenHelper.sha256('kyc_other') ? 2 : 1, name: 'Acme', status: 'active'}), {update: async () => {}})});
    const call = await service(t);
    const auth = {Authorization: 'Bearer kyc_mine'};

    const c = chip(zw);
    const files = {sod: c.sod.toString('base64'), dg1: c.dg1.toString('base64'), dg2: c.dg2.toString('base64')};
    const res = await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: auth, body: {files, access: 'pace'}});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.chip.status, 'verified');
    assert.strictEqual(res.body.chip.access, 'pace');
    assert.strictEqual(res.body.chip.has_photo, true);
    assert.ok(!('_photo' in res.body.chip));
    assert.ok(fs.existsSync(path.join(storage, scan.public_id, 'chip-sod.bin')));

    const photo = await call('GET', `/api/kyc/passport/${scan.public_id}/chip/photo`, {headers: auth});
    assert.strictEqual(photo.status, 200);
    assert.ok(photo.body.equals(JPEG));
    // Another client can't send or see it.
    const other = {Authorization: 'Bearer kyc_other'};
    assert.strictEqual((await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: other, body: {files}})).status, 404);
    assert.strictEqual((await call('GET', `/api/kyc/passport/${scan.public_id}/chip/photo`, {headers: other})).status, 404);

    // Bad input.
    assert.strictEqual((await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: auth, body: {files: {dg1: files.dg1}}})).body.error, 'sod_required');
    assert.strictEqual((await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: auth, body: {files: {...files, dg1: '%%'}}})).body.error, 'invalid_dg1');
    const broken = await call('POST', `/api/kyc/passport/${scan.public_id}/chip`, {headers: auth, body: {files: {...files, sod: Buffer.from([0x77, 0x02, 0x30, 0x00]).toString('base64')}}});
    assert.strictEqual(broken.status, 422);
    assert.strictEqual(broken.body.error, 'chip_data_invalid');

    // The chip files aren't kept in the request log.
    await new Promise((r) => setTimeout(r, 20));
    assert.match(logged[0].request.body.files, /not logged/);
    assert.strictEqual(logged[0].check_type, 'passport_chip');
});
