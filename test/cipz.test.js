const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cipzHelper = require('../helpers/cipz/cipzHelper');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('reads a registered company, moving the name suffix off the number line', () => {
    assert.deepStrictEqual(cipzHelper.parsePage(fixture('cipz-found.html')), {
        found: true,
        name: 'EXPRESS SMATPAY (PRIVATE) LIMITED',
        number: '38043A0242025',
        address: '3 FALMOUTH ROAD, ALEXANDRA PARK, HARARE ZIMBABWE',
        status: 'Verified',
        verified: true,
    });
});

test('treats the error page as not found', () => {
    assert.deepStrictEqual(cipzHelper.parsePage(fixture('cipz-not-found.html')), {found: false});
});

test('reports a status other than Verified as not verified', () => {
    const html = '<h4>Name: ACME</h4><h4>Number: 1234/2010 (PRIVATE) LIMITED</h4><h4>Address: X</h4><h4>Pending</h4>';
    const result = cipzHelper.parsePage(html);
    assert.strictEqual(result.status, 'Pending');
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.number, '1234/2010');
});

test('refuses a page it does not recognise', () => {
    assert.throws(() => cipzHelper.parsePage('<html><body>Maintenance</body></html>'));
});

test('validates registration numbers', () => {
    assert.ok(cipzHelper.isValidNumber('38043A0242025'));
    assert.ok(cipzHelper.isValidNumber('1234/2010'));
    assert.ok(!cipzHelper.isValidNumber(''));
    assert.ok(!cipzHelper.isValidNumber('38043A0242025?x=1'));
    assert.ok(!cipzHelper.isValidNumber('a b'));
});
