/**
 * The tamper classifier: logistic regression (helpers/ml/softmax.js) on a document's features (features.js),
 * trained on checks an admin labelled genuine or doctored, and on generated documents (tools/doccheck).
 *
 * It's saved as config/doc-models/doc.json (or DOC_MODEL_DIR) and only used ("active") when, on documents
 * held back from training, it does at least as well as the rules' verdict. Held-back documents are real
 * ones when there are enough (10+); a model tested only on generated documents isn't made active unless
 * asked (`activateSynthetic`), since generated documents say little about real forgeries.
 */
const fs = require('fs');
const path = require('path');
const {trainSoftmax, predict, shuffled} = require('../ml/softmax');
const features = require('./features');

const CLASSES = ['genuine', 'doctored'];
const modelDir = () => process.env.DOC_MODEL_DIR || path.join(__dirname, '..', '..', 'config', 'doc-models');
const minSamples = () => Number(process.env.DOC_MODEL_MIN_SAMPLES || 30);

/** How the rules' verdict reads as a yes/no: anything not clean counts as "doctored". */
const rulesSay = (verdict) => (verdict === 'clean' ? 'genuine' : 'doctored');

function metrics(samples, guess) {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;
    for (const s of samples) {
        const g = guess(s);
        if (s.label === 'doctored') g === 'doctored' ? tp++ : fn++;
        else g === 'genuine' ? tn++ : fp++;
    }
    const n = samples.length || 1;
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
        accuracy: r((tp + tn) / n),
        // Of the documents it called doctored, how many were; and of the doctored ones, how many it caught.
        precision: tp + fp ? r(tp / (tp + fp)) : null,
        recall: tp + fn ? r(tp / (tp + fn)) : null,
        false_alarms: fp,
        missed: fn,
        n: samples.length,
    };
}

/**
 * Trains on samples {features: number[], label: 'genuine'|'doctored', rules_verdict, source?}. Returns the
 * model, ready to save, with `active` and the metrics behind it.
 */
function train(samples, {version = 1, now = new Date(), testShare = 0.2, activateSynthetic = false} = {}) {
    const usableSamples = samples.filter((s) => CLASSES.includes(s.label) && Array.isArray(s.features) && s.features.length === features.NAMES.length);
    if (!usableSamples.length) throw new Error('no labelled documents to train on');
    if (new Set(usableSamples.map((s) => s.label)).size < 2) throw new Error('need both genuine and doctored documents to train on');
    const real = shuffled(usableSamples.filter((s) => s.source !== 'synthetic'));
    const testFrom = real.length >= 10 ? real : shuffled(usableSamples);
    const testCount = testFrom.length >= 10 ? Math.max(1, Math.round(testFrom.length * testShare)) : 0;
    const test = testFrom.slice(0, testCount);
    const held = new Set(test);
    const trainSet = usableSamples.filter((s) => !held.has(s));
    const testedOnReal = test.length > 0 && test.every((s) => s.source !== 'synthetic');

    const m = trainSoftmax(trainSet.map((s) => s.features), trainSet.map((s) => s.label), CLASSES, {epochs: 600, rate: 0.4, l2: 2e-3});
    const evalSet = test.length ? test : trainSet;
    const model = {version, feature_version: features.VERSION, feature_names: features.NAMES, trained_at: now.toISOString(), weights: m};
    const modelMetrics = metrics(evalSet, (s) => (assessWith(model, s.features).tampered_probability >= 0.5 ? 'doctored' : 'genuine'));
    const rulesMetrics = metrics(evalSet, (s) => rulesSay(s.rules_verdict));
    const enough = trainSet.length >= minSamples() && test.length > 0;
    const better = modelMetrics.accuracy >= rulesMetrics.accuracy;
    return {
        ...model,
        active: enough && better && (testedOnReal || activateSynthetic),
        samples: {
            train: trainSet.length, test: test.length, real: real.length, synthetic: usableSamples.length - real.length,
            doctored: usableSamples.filter((s) => s.label === 'doctored').length, min_needed: minSamples(),
        },
        metrics: {model: modelMetrics, rules: rulesMetrics, tested_on: !test.length ? 'training_set' : testedOnReal ? 'held_out' : 'held_out_with_synthetic'},
        // The features that push hardest towards "doctored", for people reading the model file.
        strongest: features.NAMES.map((name, j) => ({name, weight: Math.round((m.W[1][j] - m.W[0][j]) * 1000) / 1000}))
            .filter((w) => w.name !== 'bias').sort((a, b) => b.weight - a.weight).slice(0, 8),
    };
}

function assessWith(model, values) {
    const p = predict(model.weights, values);
    return {tampered_probability: Math.round(p.doctored * 1000) / 1000};
}

// ----- The saved model -----

let cached;

/** The saved model, or null. Cached; reload() reads the file again. */
function load() {
    if (cached !== undefined) return cached;
    cached = null;
    try {
        cached = JSON.parse(fs.readFileSync(path.join(modelDir(), 'doc.json'), 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not load the document model:', err.message);
    }
    return cached;
}

/** Built on today's features (so it can be run at all). */
const compatible = (m) => Boolean(m && m.feature_version === features.VERSION && m.weights);

function reload() {
    cached = undefined;
}

/** Writes config/doc-models/doc.json, keeping the previous one as doc.v<n>.json. */
function save(model) {
    const dir = modelDir();
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, 'doc.json');
    if (fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, path.join(dir, `doc.v${old.version}.json`));
    }
    fs.writeFileSync(file, JSON.stringify(model));
    reload();
    return file;
}

/**
 * What the saved model makes of a document's features: {tampered_probability, version, active}, or null
 * when there's no model that can run on them. `active` says whether the verdict uses it.
 */
function assess(values) {
    const m = load();
    if (!compatible(m)) return null;
    return {...assessWith(m, values), version: m.version, active: Boolean(m.active)};
}

/** The model without its weights, for the admin site. */
function summary() {
    const m = load();
    if (!m) return null;
    return {
        version: m.version, active: Boolean(m.active), usable: compatible(m) && Boolean(m.active), trained_at: m.trained_at,
        feature_version: m.feature_version, samples: m.samples, metrics: m.metrics, strongest: m.strongest,
    };
}

module.exports = {train, assess, load, reload, save, summary, metrics, rulesSay, CLASSES};
