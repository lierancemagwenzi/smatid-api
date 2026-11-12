#!/usr/bin/env node
/**
 * Writes the proofreader's sample documents as PDFs, to try in the client portal or with the API:
 * a clean bank statement, payslip and utility bill, and doctored copies of each; and, once
 * `python tools/docforensics/forge.py --samples storage/doccheck-samples/scans` has drawn them, a clean and a
 * forged scanned page.
 *
 *   node tools/doccheck/make-samples.js [out-dir]      default storage/doccheck-samples
 *
 * Everyone and everything in them is made up.
 */
const fs = require('fs');
const path = require('path');
const samples = require('./samples');
const scans = require('./scans');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'storage', 'doccheck-samples'));
const KINDS = {statement: samples.bankStatement, payslip: samples.payslip, bill: samples.utilityBill};
const DOCTORS = [[], ['font'], ['balance'], ['incremental'], ['cover'], ['annotation']];

(async () => {
    fs.mkdirSync(out, {recursive: true});
    let n = 0;
    for (const [kind, make] of Object.entries(KINDS)) {
        for (const doctor of [...DOCTORS, ...(kind === 'bill' ? [['name']] : [])]) {
            const name = `${kind}-${doctor.length ? doctor.join('-') : 'clean'}.pdf`;
            fs.writeFileSync(path.join(out, name), await make({doctor}));
            n++;
        }
    }
    // Scanned ones, from the pictures tools/docforensics/forge.py --samples draws.
    for (const name of ['scan-clean', 'scan-forged']) {
        const jpg = path.join(scans.DIR, `${name}.jpg`);
        if (!fs.existsSync(jpg)) continue;
        fs.writeFileSync(path.join(out, `${name}.pdf`), await scans.scannedPdf(jpg));
        n++;
    }
    console.log(`Wrote ${n} sample PDFs to ${out}`);
})();
