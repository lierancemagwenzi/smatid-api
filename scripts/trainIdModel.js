// Trains a country's ID card model on the scans admins have labelled, tests it on 20% held back, and
// saves it to config/id-models/<COUNTRY>.json. It's only used for reading cards if it did at least as
// well as the rules on those held-back scans (and there were enough to train on: ID_MODEL_MIN_SAMPLES).
//   npm run idmodel:train -- --country ZW            train and save
//   npm run idmodel:train -- --country ZW --dry-run  train and report, save nothing
//   … --synthetic storage/synthetic/ZW               add drawn cards (tools/idcard-synth/README.md)
//   … --no-db                                        don't read labelled scans from the database
//   … --activate-synthetic                           let a model tested only on drawn cards be used
// Then reload it on the running server: POST /api/admin/id-models/reload (or the ID cards admin page).
require('dotenv').config({quiet: true});
const {Op} = require('sequelize');
const db = require('../models');
const idcard = require('../helpers/idcard');
const ocrInput = require('../helpers/idcard/ocrInput');
const model = require('../helpers/idcard/model');
const synthetic = require('../helpers/idcard/synthetic');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};

const pct = (v) => (v === null || v === undefined ? '   -  ' : `${(v * 100).toFixed(1).padStart(5)}%`);

(async () => {
    const profile = idcard.profile(arg('country'));
    if (!profile) throw new Error(`Give --country, one of: ${idcard.supported().map((c) => c.code).join(', ')}`);

    const samples = [];
    if (!process.argv.includes('--no-db')) {
        const rows = await db.id_card_scan.findAll({where: {country: profile.code, labelled_at: {[Op.ne]: null}}, order: [['id', 'ASC']]});
        for (const row of rows) {
            try {
                samples.push({lines: ocrInput.parse(row.ocr), label: row.label, source: 'real'});
            } catch {
                console.warn(`Skipping ${row.public_id}: its OCR can't be read`);
            }
        }
        console.log(`${samples.length} labelled ${profile.name} scans`);
    }
    if (arg('synthetic')) {
        const drawn = synthetic.load(arg('synthetic'), profile.code);
        samples.push(...drawn.samples);
        console.log(`${drawn.samples.length} drawn cards${drawn.unread ? ` (${drawn.unread} more had no readable text)` : ''}`);
    }
    if (!samples.length) throw new Error('Nothing to train on yet: label some scans in the admin site, or give --synthetic');

    const previous = model.load(profile.code);
    const trained = model.train(samples, profile, {
        version: previous ? previous.version + 1 : 1,
        activateSynthetic: process.argv.includes('--activate-synthetic'),
    });

    const {model: m, rules: r, tested_on: on} = trained.metrics;
    const testedOn = {
        held_out: `${trained.samples.test} held-back real scans`,
        held_out_with_synthetic: `${trained.samples.test} held-back cards, drawn ones included (flatters the model: check on real cards)`,
        training_set: 'the training scans (too few to hold any back)',
    }[on];
    console.log(`\nAccuracy on ${testedOn}:`);
    console.log('  field               model    rules');
    for (const f of profile.fields) {
        if (m.fields[f].total) console.log(`  ${f.padEnd(18)} ${pct(m.fields[f].accuracy)}  ${pct(r.fields[f].accuracy)}   (${m.fields[f].total})`);
    }
    console.log(`  ${'card type'.padEnd(18)} ${pct(m.card_type.accuracy)}  ${pct(r.card_type.accuracy)}`);
    console.log(`  ${'overall'.padEnd(18)} ${pct(m.overall)}  ${pct(r.overall)}`);

    if (!trained.active) {
        const why = trained.samples.train < trained.samples.min_needed
            ? `only ${trained.samples.train} training scans; ${trained.samples.min_needed} needed`
            : m.overall < (r.overall || 0)
                ? 'it did worse than the rules'
                : 'it was only tested on drawn cards; add --activate-synthetic to use it anyway';
        console.log(`\nNot active (${why}): cards keep being read by the rules.`);
    } else {
        console.log(`\nActive: version ${trained.version} will read ${profile.name} cards once the server reloads it.`);
    }

    if (process.argv.includes('--dry-run')) {
        console.log('Dry run: nothing saved.');
        return;
    }
    console.log(`Saved ${model.save(trained)}`);
})()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => db.sequelize.close());
