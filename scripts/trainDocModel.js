// Trains the document tamper classifier on the checks admins have labelled genuine or doctored (and, to start
// with, on generated documents), tests it on 20% held back, and saves it to config/doc-models/doc.json.
// It's only used if it did at least as well as the rules on the held-back documents, and there were enough
// to train on (DOC_MODEL_MIN_SAMPLES, 30). See helpers/document/model.js.
//   npm run docmodel:train                         train on labelled checks and save
//   npm run docmodel:train -- --dry-run            train and report, save nothing
//   … --synthetic 600                              add 600 generated documents (tools/doccheck/samples.js)
//   … --no-db                                      don't read labelled checks from the database
//   … --activate-synthetic                         let a model tested only on generated documents be used
// Then reload it on the running server: POST /api/admin/doc-model/reload (or the admin site's Documents tab).
require('dotenv').config({quiet: true});
const {Op} = require('sequelize');
const db = require('../models');
const documentCheck = require('../helpers/document');
const features = require('../helpers/document/features');
const model = require('../helpers/document/model');
const samples = require('../tools/doccheck/samples');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const pct = (v) => (v === null || v === undefined ? '   -  ' : `${(v * 100).toFixed(1).padStart(5)}%`);

(async () => {
    const data = [];
    if (!process.argv.includes('--no-db')) {
        const rows = await db.document_check.findAll({where: {labelled_at: {[Op.ne]: null}}, order: [['id', 'ASC']]});
        let stale = 0;
        for (const row of rows) {
            const f = row.features;
            if (!f || f.version !== features.VERSION) {
                stale++;
                continue;
            }
            data.push({features: f.values, label: row.label.verdict, rules_verdict: row.verdict, source: 'real'});
        }
        console.log(`${data.length} labelled checks${stale ? ` (${stale} more were measured with older features and can't be used)` : ''}`);
    }
    const count = Number(arg('synthetic') || 0);
    if (count) {
        process.stdout.write(`Generating and checking ${count} documents`);
        for (let i = 0; i < count; i++) {
            const v = await samples.variant(i);
            const r = await documentCheck.analyse(v.bytes);
            data.push({features: r.features.values, label: v.label, rules_verdict: r.verdict, source: 'synthetic'});
            if (i % 50 === 49) process.stdout.write('.');
        }
        console.log();
    }
    if (!data.length) throw new Error('Nothing to train on yet: label some checks in the admin site, or give --synthetic <count>');

    const previous = model.load();
    const trained = model.train(data, {
        version: previous ? previous.version + 1 : 1,
        activateSynthetic: process.argv.includes('--activate-synthetic'),
    });
    const {model: m, rules: r, tested_on: on} = trained.metrics;
    const testedOn = {
        held_out: `${trained.samples.test} held-back real documents`,
        held_out_with_synthetic: `${trained.samples.test} held-back documents, generated ones included (flatters the model: check on real documents)`,
        training_set: 'the training documents (too few to hold any back)',
    }[on];
    console.log(`\nOn ${testedOn}:`);
    console.log('                 model    rules');
    console.log(`  accuracy      ${pct(m.accuracy)}  ${pct(r.accuracy)}`);
    console.log(`  precision     ${pct(m.precision)}  ${pct(r.precision)}   (of those called doctored, how many were)`);
    console.log(`  recall        ${pct(m.recall)}  ${pct(r.recall)}   (of the doctored, how many were caught)`);
    console.log(`  false alarms  ${String(m.false_alarms).padStart(6)}  ${String(r.false_alarms).padStart(6)}`);
    console.log(`  missed        ${String(m.missed).padStart(6)}  ${String(r.missed).padStart(6)}`);
    console.log(`\nStrongest signs of tampering it learned: ${trained.strongest.map((s) => `${s.name} (${s.weight})`).join(', ')}`);

    if (!trained.active) {
        const why = trained.samples.train < trained.samples.min_needed
            ? `only ${trained.samples.train} training documents; ${trained.samples.min_needed} needed`
            : m.accuracy < r.accuracy
                ? 'it did worse than the rules'
                : 'it was only tested on generated documents; add --activate-synthetic to use it anyway';
        console.log(`\nNot active (${why}): its probability is shown in reports, but verdicts stay the rules'.`);
    } else {
        console.log(`\nActive: version ${trained.version} will weigh in on verdicts once the server reloads it.`);
    }

    if (process.argv.includes('--dry-run')) {
        console.log('Dry run: nothing saved.');
    } else {
        console.log(`Saved ${model.save(trained)}`);
    }
    await db.sequelize.close();
})().catch(async (err) => {
    console.error(err.message);
    await db.sequelize.close().catch(() => {});
    process.exit(1);
});
