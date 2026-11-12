const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const db = require('../models');

function stub(t, target, methods) {
    for (const [name, fn] of Object.entries(methods)) {
        const original = target[name];
        target[name] = fn;
        t.after(() => (target[name] = original));
    }
}

async function service(t) {
    const app = express();
    app.use(express.json());
    require('../routes/kycRoutes')(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (p, headers = {}) => {
        const res = await fetch(base + p, {headers});
        return {status: res.status, body: await res.json()};
    };
}

const admin = {'X-Admin-Key': 'admin-secret'};

function adminKey(t) {
    process.env.ADMIN_API_KEY = 'admin-secret';
    t.after(() => delete process.env.ADMIN_API_KEY);
}

test('admins list every passport scan, newest first, filtered by result and client', async (t) => {
    adminKey(t);
    let asked;
    stub(t, db.passport_scan, {
        findAndCountAll: async (q) => {
            asked = q;
            const scan = db.passport_scan.build({public_id: 'ps_' + 'a'.repeat(32), client_id: 7, status: 'passed', image_file: 'x.jpg', createdAt: new Date()});
            scan.client = {id: 7, name: 'Acme'};
            return {rows: [scan], count: 41};
        },
    });
    const call = await service(t);

    const res = await call('/api/admin/passports?status=passed&client_id=7&page=2&per_page=20', admin);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(asked.where, {status: 'passed', client_id: 7});
    assert.deepStrictEqual([asked.limit, asked.offset], [20, 20]);
    assert.deepStrictEqual(asked.order, [['created_at', 'DESC']]);
    assert.strictEqual(res.body.total, 41);
    assert.strictEqual(res.body.scans[0].scan_id, 'ps_' + 'a'.repeat(32));
    assert.strictEqual(res.body.scans[0].has_image, true);
    assert.strictEqual(res.body.scans[0].client.name, 'Acme');

    // Junk filters are ignored, not passed to the database.
    await call('/api/admin/passports?client_id=1;DROP&per_page=5000', admin);
    assert.deepStrictEqual(asked.where, {});
    assert.strictEqual(asked.limit, 100);

    assert.strictEqual((await call('/api/admin/passports')).status, 401);
});

test('admins list every liveness check, with the frame to show for it when one was kept', async (t) => {
    adminKey(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
    process.env.LIVENESS_STORAGE_DIR = dir;
    t.after(() => {
        delete process.env.LIVENESS_STORAGE_DIR;
        fs.rmSync(dir, {recursive: true, force: true});
    });
    const kept = 'lv_' + 'k'.repeat(32);
    const none = 'lv_' + 'n'.repeat(32);
    fs.mkdirSync(path.join(dir, kept));
    fs.writeFileSync(path.join(dir, kept, 'attempt-2-0-center.jpg'), 'jpeg');
    stub(t, db.liveness_session, {
        findAndCountAll: async () => {
            const rows = [
                db.liveness_session.build({public_id: kept, client_id: 1, status: 'passed', attempts: 2, expires_at: new Date(Date.now() - 1000), createdAt: new Date()}),
                db.liveness_session.build({public_id: none, client_id: 1, status: 'pending', attempts: 0, expires_at: new Date(Date.now() - 1000), createdAt: new Date()}),
            ];
            return {rows, count: 2};
        },
    });
    const call = await service(t);

    const res = await call('/api/admin/liveness', admin);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.total, 2);
    assert.deepStrictEqual(res.body.sessions.map((s) => [s.session_id, s.status, s.photo]), [
        [kept, 'passed', 'attempt-2-0-center.jpg'],
        // Never finished, and now past its expiry.
        [none, 'expired', null],
    ]);
    assert.strictEqual((await call('/api/admin/liveness')).status, 401);
});
