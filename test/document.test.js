const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const db = require('../models');
const tokenHelper = require('../helpers/tokenHelper');
const billing = require('../helpers/billing/billingHelper');
const documentCheck = require('../helpers/document');
const pdf = require('../helpers/document/pdf');
const structure = require('../helpers/document/structure');
const metadata = require('../helpers/document/metadata');
const {parseAmount, parseDate} = require('../helpers/document/text');
const samples = require('../tools/doccheck/samples');

const NOW = new Date('2026-11-12T00:00:00Z');
const analyse = (bytes, opts = {}) => documentCheck.analyse(bytes, {now: NOW, ...opts});
const codes = (report) => report.findings.map((f) => f.code);

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

// ----- Reading figures and dates -----

test('amounts are read as printed: thousands, negatives, brackets, currencies, decimal commas', () => {
    assert.strictEqual(parseAmount('1,250.40').value, 1250.4);
    assert.strictEqual(parseAmount('-63.00').value, -63);
    assert.strictEqual(parseAmount('(63.00)').value, -63);
    assert.strictEqual(parseAmount('USD 1 250.40').value, 1250.4);
    assert.strictEqual(parseAmount('1.250,40').value, 1250.4);
    assert.strictEqual(parseAmount('63.00 DR').value, -63);
    assert.strictEqual(parseAmount('4100 2233 9871'), null);
    assert.strictEqual(parseAmount('01/09/2026'), null);
    assert.strictEqual(parseAmount('Balance'), null);
});

test('dates are read in the forms documents print, and impossible ones are caught', () => {
    assert.deepStrictEqual(parseDate('01/09/2026'), {date: '2026-09-01'});
    assert.deepStrictEqual(parseDate('2026-09-30'), {date: '2026-09-30'});
    assert.deepStrictEqual(parseDate('12 Sep 2026'), {date: '2026-09-12'});
    assert.deepStrictEqual(parseDate('12-Sept-26'), {date: '2026-09-12'});
    assert.strictEqual(parseDate('31/02/2026').invalid, true);
    assert.strictEqual(parseDate('hello'), null);
    assert.strictEqual(metadata.parseDate("D:20261001083000+02'00'").toISOString(), '2026-10-01T06:30:00.000Z');
});

// ----- Each check, on clean documents and on doctored ones -----

test('clean documents come back clean', async () => {
    for (const make of [samples.bankStatement, samples.payslip, samples.utilityBill]) {
        const r = await analyse(await make());
        assert.strictEqual(r.verdict, 'clean', `${make.name}: ${codes(r).join()}`);
        assert.strictEqual(r.score, 0);
    }
});

test('the kind of document is recognised, or taken from the caller', async () => {
    assert.strictEqual((await analyse(await samples.bankStatement())).document.type, 'bank_statement');
    assert.strictEqual((await analyse(await samples.payslip())).document.type, 'payslip');
    assert.strictEqual((await analyse(await samples.utilityBill())).document.type, 'utility_bill');
    const forced = await analyse(await samples.payslip(), {type: 'other'});
    assert.strictEqual(forced.document.type, 'other');
    assert.strictEqual(forced.document.type_detected, 'payslip');
});

test('a figure retyped in another font, off its row, is found, and the broken balance with it', async () => {
    const r = await analyse(await samples.bankStatement({doctor: ['font']}));
    assert.strictEqual(r.verdict, 'suspicious');
    const font = r.findings.find((f) => f.code === 'font_out_of_place');
    assert.ok(font, codes(r).join());
    assert.match(font.evidence.font, /Times/);
    assert.strictEqual(font.page, 1);
    assert.strictEqual(font.box.length, 4);
    assert.ok(codes(r).includes('off_baseline'));
    assert.ok(codes(r).includes('balance_mismatch'));
    // The highlight is where the figure is: in the debit/credit columns, a third of the way down.
    assert.ok(font.box[0] > 0.6 && font.box[1] > 0.25 && font.box[1] < 0.5, JSON.stringify(font.box));
});

test('sums that don\'t add up are found on each kind of document', async () => {
    const statement = await analyse(await samples.bankStatement({doctor: ['balance']}));
    assert.ok(codes(statement).includes('balance_mismatch'));
    assert.ok(codes(statement).includes('total_mismatch'));
    const mismatch = statement.findings.find((f) => f.code === 'balance_mismatch');
    assert.strictEqual(Math.abs(mismatch.evidence.difference), 100);

    assert.ok(codes(await analyse(await samples.payslip({doctor: ['balance']}))).includes('net_pay_mismatch'));
    assert.ok(codes(await analyse(await samples.utilityBill({doctor: ['balance']}))).includes('amount_due_mismatch'));
});

test('a save on top of the original by a PDF editor is found in the file\'s history and metadata', async () => {
    const bytes = await samples.payslip({doctor: ['incremental']});
    const s = structure.analyse(bytes);
    assert.strictEqual(s.revisions, 2);
    assert.strictEqual(s.updates, 1);
    assert.deepStrictEqual(s.producers, ['PayrollPro 9', 'iLovePDF']);

    const r = await analyse(bytes);
    assert.strictEqual(r.verdict, 'suspicious');
    for (const code of ['incremental_updates', 'producer_changed', 'pdf_editor']) assert.ok(codes(r).includes(code), code);
    assert.strictEqual(r.metadata.producer, 'iLovePDF');
    assert.strictEqual(r.structure.incremental_updates, 1);
});

test('a white box over a figure, with another written on top, is found', async () => {
    const r = await analyse(await samples.utilityBill({doctor: ['cover']}));
    const covered = r.findings.find((f) => f.code === 'text_covered');
    assert.ok(covered, codes(r).join());
    assert.strictEqual(covered.evidence.written_over, true);
    assert.ok(codes(r).includes('text_over_text'));
});

test('a white annotation laid over a figure is found', async () => {
    const r = await analyse(await samples.payslip({doctor: ['annotation']}));
    const a = r.findings.find((f) => f.code === 'annotation_covers_text');
    assert.ok(a, codes(r).join());
    assert.deepStrictEqual(a.evidence.covers.length > 0, true);
});

test('a name given two ways in one document is found', async () => {
    const r = await analyse(await samples.utilityBill({doctor: ['name']}));
    const f = r.findings.find((x) => x.code === 'field_mismatch');
    assert.ok(f, codes(r).join());
    assert.deepStrictEqual(f.evidence.values.map((v) => v.value), ['TENDAI MOYO', 'TENDAI MOYA']);
});

test('metadata: editors, office software on issued documents, future and backwards dates', () => {
    const base = {producer: 'HB Core', creator: 'HB Core', created: new Date('2026-10-01T08:00:00Z'), modified: new Date('2026-10-01T08:00:00Z'), xmp: null, producers_over_time: []};
    assert.deepStrictEqual(metadata.findings(base, {docType: 'bank_statement', now: NOW}), []);
    const word = metadata.findings({...base, creator: 'Microsoft® Word for Microsoft 365'}, {docType: 'payslip', now: NOW});
    assert.deepStrictEqual(word.map((f) => [f.code, f.severity]), [['office_software', 'warning']]);
    assert.strictEqual(metadata.findings({...base, creator: 'Microsoft Word'}, {docType: 'other', now: NOW})[0].severity, 'info');
    assert.ok(metadata.findings({...base, producer: 'Adobe Photoshop 25.0'}, {now: NOW}).some((f) => f.code === 'image_editor'));
    const future = metadata.findings({...base, created: new Date('2027-01-01'), modified: new Date('2027-01-01')}, {now: NOW});
    assert.ok(future.some((f) => f.code === 'date_in_future'));
    const later = metadata.findings({...base, modified: new Date('2026-10-20T15:00:00Z')}, {now: NOW});
    assert.ok(later.some((f) => f.code === 'modified_after_creation'));
    const xmp = metadata.findings({...base, xmp: {producer: 'iLovePDF', creator_tool: null, created: null, modified: null}}, {now: NOW});
    assert.ok(xmp.some((f) => f.code === 'metadata_disagrees'));
    assert.ok(metadata.findings({producer: null, creator: null, created: null, modified: null, xmp: null}, {docType: 'payslip'}).some((f) => f.code === 'metadata_missing'));
});

test('files that aren\'t readable PDFs say why', async () => {
    await assert.rejects(pdf.read(Buffer.from('%PDF-1.7\nnot really a pdf')), (e) => e.code === 'pdf_unreadable');
    const bytes = await samples.payslip();
    await assert.rejects(pdf.read(bytes, {maxPages: 0}), (e) => e.code === 'too_many_pages');
});

// ----- The API -----

async function service(t) {
    const app = express();
    app.use(['/api/kyc/document', '/api/portal/checks/document'], express.json({limit: '21mb'}));
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, p, {headers = {}, body} = {}) => {
        const res = await fetch(base + p, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
        return {status: res.status, body: await res.json()};
    };
}

/** An in-memory document_checks table, a client per token, the module at `cost` credits, and the credits ledger. */
function world(t, {cost = 3} = {}) {
    const rows = [];
    const ledger = [];
    stub(t, db.api_request, {create: async () => {}});
    stub(t, db.document_check, {
        create: async (fields) => {
            const r = db.document_check.build({id: rows.length + 1, ...fields, createdAt: new Date()});
            rows.push(r);
            return r;
        },
        count: async ({where}) => rows.filter((r) => r.client_id === where.client_id && r.sha256 === where.sha256).length,
        findOne: async ({where}) => rows.find((r) => r.public_id === where.public_id && r.client_id === where.client_id) || null,
    });
    stub(t, db.kyc_module, {findOne: async ({where}) => db.kyc_module.build({key: where.key, name: where.key, status: 'enabled', credit_cost: cost})});
    stub(t, db.client, {findOne: async ({where}) => {
        const id = where.token_hash === tokenHelper.sha256('kyc_other') ? 2 : 1;
        return Object.assign(db.client.build({id, name: 'Acme Bank', status: 'active'}), {update: async () => {}});
    }});
    stub(t, billing, {
        reserve: async (clientId, amount, type) => {
            ledger.push(['reserve', clientId, amount, type]);
            return {id: ledger.length};
        },
        refund: async (clientId, reservation, type, note) => {
            ledger.push(['refund', clientId, type, note]);
        },
    });
    return {rows, ledger};
}

const client = {Authorization: 'Bearer kyc_mine'};
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('a PDF is checked, charged, kept as a report without the file, and only its client can look it up', async (t) => {
    const {rows, ledger} = world(t);
    const call = await service(t);
    const bytes = await samples.bankStatement({doctor: ['incremental']});

    const res = await call('POST', '/api/kyc/document', {headers: client, body: {file: b64(bytes), filename: 'statement.pdf', reference: 'loan-77'}});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.check_id, /^dc_/);
    assert.strictEqual(res.body.verdict, 'suspicious');
    assert.strictEqual(res.body.document.type, 'bank_statement');
    assert.strictEqual(res.body.filename, 'statement.pdf');
    assert.strictEqual(res.body.reference, 'loan-77');
    assert.strictEqual(res.body.checked_before, 0);
    assert.ok(res.body.findings.length);
    assert.deepStrictEqual(ledger, [['reserve', 1, 3, 'document']]);
    // Only a fingerprint of the file is kept.
    assert.strictEqual(rows[0].sha256.length, 64);
    assert.ok(!JSON.stringify(rows[0].toJSON()).includes(b64(bytes).slice(100, 140)));

    const again = await call('POST', '/api/kyc/document', {headers: client, body: {file: b64(bytes)}});
    assert.strictEqual(again.body.checked_before, 1);

    const shown = await call('GET', `/api/kyc/document/${res.body.check_id}`, {headers: client});
    assert.strictEqual(shown.status, 200);
    assert.strictEqual(shown.body.verdict, 'suspicious');
    assert.strictEqual((await call('GET', `/api/kyc/document/${res.body.check_id}`, {headers: {Authorization: 'Bearer kyc_other'}})).status, 404);
    assert.strictEqual((await call('GET', '/api/kyc/document/dc_nope', {headers: client})).status, 404);
});

test('files that can\'t be checked are refused, and the credits given back', async (t) => {
    const {ledger} = world(t);
    const call = await service(t);
    const send = (body) => call('POST', '/api/kyc/document', {headers: client, body});

    assert.deepStrictEqual([(await send({})).status, (await send({})).body.error], [400, 'file_required']);
    assert.strictEqual((await send({file: b64(Buffer.from('just some text, not a pdf at all, really not one. '.repeat(3)))})).body.error, 'not_a_pdf');
    assert.strictEqual((await send({file: '***'})).body.error, 'invalid_file');
    assert.strictEqual((await send({file: b64(await samples.payslip()), type: 'passport'})).body.error, 'invalid_type');
    const broken = await send({file: b64(Buffer.from(`%PDF-1.7\n${'x'.repeat(200)}`))});
    assert.deepStrictEqual([broken.status, broken.body.error], [422, 'pdf_unreadable']);
    const reserved = ledger.filter((l) => l[0] === 'reserve').length;
    assert.strictEqual(ledger.filter((l) => l[0] === 'refund').length, reserved);
    assert.strictEqual((await call('POST', '/api/kyc/document', {body: {file: 'x'}})).status, 401);
});

test('the portal\'s document check needs a signed-in user', async (t) => {
    world(t);
    const call = await service(t);
    assert.strictEqual((await call('POST', '/api/portal/checks/document', {body: {file: 'x'}})).status, 401);
});

// ----- The tamper classifier -----

const fs = require('fs');
const os = require('os');
const path = require('path');
const docModel = require('../helpers/document/model');
const docFeatures = require('../helpers/document/features');

/** Generated documents, analysed: what the classifier trains on. */
async function trainingSet(n, source = 'synthetic') {
    const out = [];
    for (let i = 0; i < n; i++) {
        const v = await samples.variant(i);
        const r = await analyse(v.bytes);
        out.push({features: r.features.values, label: v.label, rules_verdict: r.verdict, source});
    }
    return out;
}

function modelDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-models-'));
    process.env.DOC_MODEL_DIR = dir;
    docModel.reload();
    t.after(() => {
        delete process.env.DOC_MODEL_DIR;
        docModel.reload();
        fs.rmSync(dir, {recursive: true, force: true});
    });
    return dir;
}

test('every document is measured the same way, and clients don\'t see the measurements', async (t) => {
    const r = await analyse(await samples.bankStatement({doctor: ['nudge']}));
    assert.strictEqual(r.features.version, docFeatures.VERSION);
    assert.strictEqual(r.features.values.length, docFeatures.NAMES.length);
    // Under the rules' tolerance, so the verdict is clean, but measured all the same.
    assert.strictEqual(r.verdict, 'clean');
    assert.ok(r.features.values[docFeatures.NAMES.indexOf('max_baseline_offset')] > 0.2);

    world(t);
    const call = await service(t);
    const res = await call('POST', '/api/kyc/document', {headers: client, body: {file: b64(await samples.payslip())}});
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.features, undefined);
});

test('the classifier learns from labelled documents, and is only used once real ones show it beats the rules', async (t) => {
    modelDir(t);
    // Too few to learn from: worse than the rules, so not used even when generated documents are allowed.
    const few = docModel.train(await trainingSet(120), {version: 1, activateSynthetic: true});
    if (few.metrics.model.accuracy < few.metrics.rules.accuracy) assert.strictEqual(few.active, false);

    const generated = await trainingSet(400);
    const trained = docModel.train(generated, {version: 1});
    assert.strictEqual(trained.metrics.tested_on, 'held_out_with_synthetic');
    assert.strictEqual(trained.active, false, 'generated documents alone don\'t make it active');
    assert.ok(trained.metrics.model.accuracy >= trained.metrics.rules.accuracy, JSON.stringify(trained.metrics));
    assert.ok(docModel.train(generated, {version: 1, activateSynthetic: true}).active);

    // The subtle edits the rules let through are the ones it learns: a figure a fraction of a point off its row.
    const names = trained.strongest.map((s) => s.name);
    assert.ok(names.includes('max_baseline_offset') || names.includes('mean_baseline_offset'), names.join());

    // Saved, loaded and assessed; an inactive model reports its probability without touching the verdict.
    docModel.save(trained);
    const r = await analyse(await samples.bankStatement({doctor: ['nudge']}));
    assert.strictEqual(r.model.version, 1);
    assert.strictEqual(r.model.active, false);
    assert.ok(r.model.tampered_probability > 0.5, JSON.stringify(r.model));
    assert.strictEqual(r.verdict, 'clean');

    // Active (here, by asking), it adds its own finding to a document the rules passed.
    docModel.save({...docModel.train(generated, {version: 2, activateSynthetic: true})});
    const active = await analyse(await samples.bankStatement({doctor: ['nudge']}));
    assert.strictEqual(active.model.active, true);
    assert.ok(codes(active).includes('model_suspects_tampering'), JSON.stringify(active.model));
    assert.notStrictEqual(active.verdict, 'clean');
    assert.ok(fs.existsSync(path.join(process.env.DOC_MODEL_DIR, 'doc.v1.json')), 'the previous model is kept');
    // It never clears a clean document's rules, and never makes a genuine one look doctored on its own.
    assert.strictEqual((await analyse(await samples.payslip())).verdict, 'clean');

    assert.throws(() => docModel.train([{features: generated[0].features, label: 'genuine', rules_verdict: 'clean'}]), /both genuine and doctored/);
});

test('admins label checks genuine or doctored, and see the classifier', async (t) => {
    modelDir(t);
    const {rows} = world(t);
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
    stub(t, db.document_check, {
        findAndCountAll: async ({where}) => {
            const found = rows.filter((r) => (where.labelled_at === null ? !r.labelled_at : true));
            return {rows: found, count: found.length};
        },
        findOne: async ({where}) => rows.find((r) => r.public_id === where.public_id && (!where.client_id || r.client_id === where.client_id)) || null,
        count: async () => rows.length,
    });
    const call = await service(t);
    const admin = {'X-Admin-Key': 'admin-secret'};
    const made = (await call('POST', '/api/kyc/document', {headers: client, body: {file: b64(await samples.utilityBill({doctor: ['name']})), filename: 'bill.pdf'}})).body;
    rows.forEach((r) => (r.update = async (fields) => Object.assign(r, fields)));

    const list = await call('GET', '/api/admin/document-checks?labelled=0', {headers: admin});
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.strictEqual(list.body.checks[0].check_id, made.check_id);
    assert.strictEqual(list.body.checks[0].verdict, 'suspicious');

    const shown = await call('GET', `/api/admin/document-checks/${made.check_id}`, {headers: admin});
    assert.strictEqual(shown.body.check.features.version, docFeatures.VERSION);

    const label = (body) => call('PUT', `/api/admin/document-checks/${made.check_id}/label`, {headers: admin, body});
    assert.strictEqual((await label({verdict: 'doctored', note: 'Issuer confirmed the name was changed'})).status, 200);
    assert.deepStrictEqual(rows[0].label, {verdict: 'doctored', note: 'Issuer confirmed the name was changed'});
    assert.ok(rows[0].labelled_at);
    assert.strictEqual((await label({verdict: 'maybe'})).body.error, 'invalid_verdict');
    assert.strictEqual((await label({verdict: null})).status, 200);
    assert.strictEqual(rows[0].label, null);
    assert.strictEqual((await call('PUT', `/api/admin/document-checks/${made.check_id}/label`, {body: {verdict: 'genuine'}})).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/document-checks/dc_nope', {headers: admin})).status, 404);
});

// ----- Scanned pages -----

const jpegJs = require('jpeg-js');
const {PDFDocument} = require('pdf-lib');
const imageForensics = require('../helpers/document/imageForensics');

/** A scan with nothing on it but one dark box, at known pixels, filling an A4 page. */
async function scanWithBox({x0 = 400, y0 = 300, x1 = 500, y1 = 330} = {}) {
    const width = 620;
    const height = 877;
    const data = Buffer.alloc(width * height * 4, 240);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
    const doc = await PDFDocument.create();
    doc.setProducer('Canon iR-ADV C5535 PDF');
    const img = await doc.embedJpg(jpegJs.encode({data, width, height}, 92).data);
    doc.addPage([595.28, 841.89]).drawImage(img, {x: 0, y: 0, width: 595.28, height: 841.89});
    return {bytes: Buffer.from(await doc.save()), box: [x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height]};
}

test('a scanned page\'s picture is read out of the PDF', async () => {
    const {bytes} = await scanWithBox();
    const doc = await pdf.read(bytes);
    assert.strictEqual(doc.pages[0].items.length, 0);
    const [scan] = doc.pages[0].scans;
    assert.deepStrictEqual([scan.width, scan.height], [620, 877]);
    assert.ok(Math.abs(scan.w - 595.28) < 0.01);
    assert.ok(scan.grey[0] > 200 && scan.grey[310 * 620 + 450] < 60);
});

test('the forgery model\'s marks on a scan come back as findings boxed in the right place on the page', async (t) => {
    process.env.DOC_MODEL_DIR = path.join(__dirname, 'fixtures', 'doc-models');
    imageForensics.reload();
    docModel.reload();
    t.after(() => {
        delete process.env.DOC_MODEL_DIR;
        imageForensics.reload();
        docModel.reload();
    });
    // The stub model marks dark pixels as changed, so the box is what it finds.
    const {bytes, box} = await scanWithBox();
    const r = await analyse(bytes);
    assert.strictEqual(r.document.scanned, true);
    assert.strictEqual(r.image.forgery_model, 0);
    const found = r.findings.filter((f) => f.code === 'image_edited_region');
    assert.strictEqual(found.length, 1, JSON.stringify(r.findings));
    const [x, y, w, h] = found[0].box;
    assert.ok(Math.abs(x - box[0]) < 0.02 && Math.abs(y - box[1]) < 0.02, `${found[0].box} vs ${box}`);
    assert.ok(Math.abs(w - box[2]) < 0.03 && Math.abs(h - box[3]) < 0.03, `${found[0].box} vs ${box}`);
    // A "look at" finding: a scan the model marks goes to a person, not straight to suspicious.
    assert.strictEqual(found[0].severity, 'warning');
    assert.strictEqual(r.verdict, 'review');
    assert.ok(r.features.values[docFeatures.NAMES.indexOf('image_tamper_score')] > 0.9);
});

test('without the forgery model a scan says it couldn\'t be examined, and raises nothing', async (t) => {
    modelDir(t);
    imageForensics.reload();
    t.after(() => imageForensics.reload());
    const r = await analyse((await scanWithBox()).bytes);
    assert.deepStrictEqual(codes(r).sort(), ['image_model_unavailable', 'scanned_image_only']);
    assert.strictEqual(r.verdict, 'clean');
    assert.strictEqual(r.image.forgery_model, null);
});

// ----- Layouts seen on real statements -----

/**
 * A made-up statement laid out like a real South African bank's: one unsigned Amount column with "Cr" after
 * credits, two pages, a branch code that sits 2.4 pt low in every page's footer, and headings half a point off.
 */
async function singleColumnStatement({changeRow = null} = {}) {
    const {StandardFonts, rgb} = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.setProducer('Statement Composer 2023');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let balance = 18845.71;
    let row = 0;
    for (let p = 0; p < 2; p++) {
        const page = doc.addPage([595, 842]);
        const t = (s, x, y, size = 8) => page.drawText(s, {x, y, size, font, color: rgb(0, 0, 0)});
        const r = (s, x, y, size = 8) => t(s, x - font.widthOfTextAtSize(s, size), y, size);
        t('Account Number', 40, 760); t('62000000001', 140, 760);
        t('Date', 16, 700.5, 7.5); t('Description', 209, 700, 7.5); r('Amount', 464, 700, 7.5); r('Balance', 527, 700, 7.5); t('Bank', 554, 700.5, 7.5);
        let y = 680;
        for (let i = 0; i < 12; i++, row++) {
            const credit = row % 5 === 2;
            const amount = credit ? 1500 + row : 20 + row * 3.25;
            balance = Math.round((balance + (credit ? amount : -amount)) * 100) / 100;
            const shown = row === changeRow ? amount + 500 : amount;
            t(`${String(1 + (row % 28)).padStart(2, '0')} Sep`, 12, y);
            t(credit ? 'Salary Payment' : 'Card Purchase Shop', 38, y);
            r(shown.toLocaleString('en-US', {minimumFractionDigits: 2}), 473, y);
            if (credit) t('Cr', 473, y);
            r(balance.toLocaleString('en-US', {minimumFractionDigits: 2}), 536, y);
            t('Cr', 537, y);
            y -= 14;
        }
        // The footer: the branch code a little lower than the rest of its line, on every page.
        t('118', 16, 33.4, 6); t('118', 128, 35.8, 6); t('62000000001', 181, 35.8, 6); t('2026/09/30', 245, 35.8, 6);
    }
    return Buffer.from(await doc.save());
}

test('a statement with one unsigned Amount column, Cr markers and template quirks is clean, and a changed amount is still found', async () => {
    const clean = await analyse(await singleColumnStatement(), {type: 'bank_statement'});
    assert.strictEqual(clean.verdict, 'clean', JSON.stringify(clean.findings.map((f) => [f.code, f.title])));
    assert.strictEqual(clean.figures.transactions, 24);

    const changed = await analyse(await singleColumnStatement({changeRow: 15}), {type: 'bank_statement'});
    const found = changed.findings.filter((f) => f.code === 'balance_mismatch');
    assert.strictEqual(found.length, 1, JSON.stringify(changed.findings.map((f) => f.code)));
    assert.strictEqual(found[0].page, 2);
    // Unsigned, it fits neither direction, so the difference is the change plus or minus the original amount.
    assert.ok(Math.abs(found[0].evidence.difference) >= 500, JSON.stringify(found[0].evidence));
});

test('when most balances "don\'t add up", the layout wasn\'t understood: one note, no alarm', async () => {
    const bs = require('../helpers/document/types/bankStatement');
    const doc = await pdf.read(await singleColumnStatement());
    // Scramble every amount, as a misread layout would.
    for (const p of doc.pages) for (const it of p.items) if (it.x > 430 && it.x < 470 && /\d\.\d\d$/.test(it.text)) it.text = '1.00';
    const r = bs.findings(doc);
    assert.deepStrictEqual(r.findings.map((f) => [f.code, f.severity]), [['statement_layout_not_followed', 'info']]);
});
