const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const yenteHelper = require('../helpers/sanctions/yenteHelper');
const db = require('../models');

/** A yente stand-in that records what it was sent and answers with `reply`. */
async function fakeYente(reply) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({method: req.method, url: req.url, headers: req.headers, body: body && JSON.parse(body)});
            const {status = 200, data} = reply();
            res.writeHead(status, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(data));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}

async function kycService() {
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {url: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}

const result = (id, score, match, topics) => ({
    id,
    caption: id.toUpperCase(),
    schema: 'Person',
    properties: {topics},
    datasets: ['us_ofac_sdn'],
    score,
    match,
    explanations: {},
});

test('builds a person query, leaving out empty fields', () => {
    const {query} = yenteHelper.buildQuery({
        type: 'person',
        first_name: 'Emmerson',
        last_name: 'Mnangagwa',
        birth_date: '1942',
        nationality: 'zw',
        id_number: '',
    });
    assert.deepStrictEqual(query, {
        schema: 'Person',
        properties: {firstName: ['Emmerson'], lastName: ['Mnangagwa'], birthDate: ['1942'], nationality: ['zw']},
    });
});

test('builds a company query', () => {
    const {query} = yenteHelper.buildQuery({
        type: 'company', name: 'EXPRESS SMATPAY (PRIVATE) LIMITED', registration_number: '38043A0242025', country: 'zw',
    });
    assert.deepStrictEqual(query, {
        schema: 'Company',
        properties: {name: ['EXPRESS SMATPAY (PRIVATE) LIMITED'], registrationNumber: ['38043A0242025'], country: ['zw']},
    });
});

test('rejects bodies that cannot be screened', () => {
    assert.strictEqual(yenteHelper.buildQuery({}).error, 'type_must_be_person_or_company');
    assert.strictEqual(yenteHelper.buildQuery({type: 'person', first_name: 'A'}).error, 'name_or_first_and_last_name_required');
    assert.strictEqual(yenteHelper.buildQuery({type: 'person', name: 'A B', birth_date: '12/03/1980'}).error, 'birth_date_must_be_yyyy_mm_dd');
    assert.strictEqual(yenteHelper.buildQuery({type: 'company'}).error, 'name_required');
});

test('flags sanctions and PEP hits, keeping near matches apart', async () => {
    const yente = await fakeYente(() => ({
        data: {
            limit: 10,
            responses: {
                q: {
                    status: 200,
                    total: {value: 3, relation: 'eq'},
                    query: {},
                    results: [
                        result('a', 0.95, true, ['sanction']),
                        result('b', 0.81, true, ['role.pep']),
                        result('c', 0.5, false, ['sanction.linked']),
                    ],
                },
            },
        },
    }));
    process.env.YENTE_URL = yente.url;
    process.env.YENTE_API_KEY = 'k';
    try {
        const out = await yenteHelper.screen({schema: 'Person', properties: {name: ['X']}});
        assert.strictEqual(out.hit, true);
        assert.strictEqual(out.sanctioned, true);
        assert.strictEqual(out.pep, true);
        assert.deepStrictEqual(out.matches.map((m) => m.id), ['a', 'b']);
        assert.deepStrictEqual(out.near_matches.map((m) => m.id), ['c']);
        assert.strictEqual(out.near_matches[0].sanctioned, false, 'sanction.linked is not itself sanctioned');
        assert.strictEqual(out.matches[0].url, 'https://www.opensanctions.org/entities/a/');

        const sent = yente.seen[0];
        assert.ok(sent.url.startsWith('/match/default?'));
        assert.match(sent.url, /threshold=0\.7/);
        assert.strictEqual(sent.headers.authorization, 'ApiKey k');
        assert.deepStrictEqual(sent.body, {queries: {q: {schema: 'Person', properties: {name: ['X']}}}});
    } finally {
        yente.close();
        delete process.env.YENTE_URL;
        delete process.env.YENTE_API_KEY;
    }
});

test('a clean result is not a hit', async () => {
    const yente = await fakeYente(() => ({
        data: {limit: 10, responses: {q: {status: 200, total: {value: 0}, query: {}, results: []}}},
    }));
    process.env.YENTE_URL = yente.url;
    try {
        const out = await yenteHelper.screen({schema: 'Company', properties: {name: ['ACME']}});
        assert.deepStrictEqual([out.hit, out.sanctioned, out.pep, out.matches.length], [false, false, false, 0]);
        assert.strictEqual(yente.seen[0].headers.authorization, undefined);
    } finally {
        yente.close();
        delete process.env.YENTE_URL;
    }
});

test('the endpoint answers 400 for a bad body and 502 while yente is not ready', async (t) => {
    // Any token passes; auth itself is covered in clients.test.js.
    const findOne = db.client.findOne;
    db.client.findOne = async () => Object.assign(db.client.build({status: 'active'}), {update: async () => {}});
    t.after(() => (db.client.findOne = findOne));
    const create = db.api_request.create;
    db.api_request.create = async () => {};
    t.after(() => (db.api_request.create = create));
    const moduleLookup = db.kyc_module.findOne;
    db.kyc_module.findOne = async () => db.kyc_module.build({key: 'sanctions-check', name: 'S', status: 'enabled'});
    t.after(() => (db.kyc_module.findOne = moduleLookup));

    const yente = await fakeYente(() => ({status: 503, data: {detail: 'Index not ready'}}));
    const kyc = await kycService();
    process.env.YENTE_URL = yente.url;
    try {
        const post = (body) => fetch(`${kyc.url}/api/kyc/sanctions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: 'Bearer kyc_test'},
            body: JSON.stringify(body),
        });
        const bad = await post({type: 'robot'});
        assert.strictEqual(bad.status, 400);

        const down = await post({type: 'person', name: 'John Doe'});
        assert.strictEqual(down.status, 502);
        assert.deepStrictEqual(await down.json(), {error: 'screening_unavailable'});
    } finally {
        yente.close();
        kyc.close();
        delete process.env.YENTE_URL;
    }
});
