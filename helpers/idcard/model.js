/**
 * Each country's trained ID card model: a field tagger (which OCR line holds which field) and a
 * card-type classifier, both multinomial logistic regression over helpers/idcard/features.js.
 *
 * Small, plain JavaScript, and trained in seconds on a few hundred labelled cards, which is the scale
 * we'll have. It learns the country's layout (where each field sits, which label sits above it) from
 * scans an admin has labelled, so it copes with cards the hand-written rules don't.
 *
 * Models live in config/id-models/<COUNTRY>.json (or ID_MODEL_DIR). A model is only used once training
 * found it at least as accurate as the rules on scans it wasn't trained on (`active: true`).
 */
const fs = require('fs');
const path = require('path');
const features = require('./features');
const {stripLabel} = require('./common');
const {trainSoftmax, predict, shuffled} = require('../ml/softmax');

const OTHER = 'other';
const modelDir = () => process.env.ID_MODEL_DIR || path.join(__dirname, '..', '..', 'config', 'id-models');
const minSamples = () => Number(process.env.ID_MODEL_MIN_SAMPLES || 30);

// ----- Reading a card with a model -----

const MIN_P = 0.3;

/**
 * Reads the card's lines with the country's model: {fields, card_type, confidence}. Each field takes
 * the line the model is surest of whose text makes a valid value; a line gives only one field.
 */
function extract(model, lines, profile) {
    const X = features.lineFeatures(lines, profile);
    const probs = X.map((x) => predict(model.field_model, x));
    const picks = [];
    for (const field of profile.fields) {
        for (let i = 0; i < lines.length; i++) if (probs[i][field] >= MIN_P) picks.push({field, i, p: probs[i][field]});
    }
    picks.sort((a, b) => b.p - a.p);
    const fields = {};
    const confidence = {};
    const used = new Set();
    for (const {field, i, p} of picks) {
        if (field in fields || used.has(i)) continue;
        const text = lines[i].text;
        const value = profile.normalise(field, stripLabel(text, profile.labels[field])) || profile.normalise(field, text);
        if (!value) continue;
        fields[field] = value;
        confidence[field] = Math.round(p * 1000) / 1000;
        used.add(i);
    }
    let cardType = null;
    if (model.card_model) {
        const p = predict(model.card_model, features.cardFeatures(lines, profile));
        cardType = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
        confidence.card_type = Math.round(p[cardType] * 1000) / 1000;
    }
    return {fields, card_type: cardType, confidence};
}

/**
 * A model's read with the rules' fields put in: the ones the country reads by pattern (profile.ruleFields)
 * come from the rules whenever they found them, and anything the model missed is filled from the rules.
 * Returns {fields, card_type, confidence, from_rules}.
 */
function combine(profile, modelOut, ruled) {
    const fields = {...modelOut.fields};
    for (const f of profile.ruleFields || []) {
        if (ruled.fields[f] !== undefined) fields[f] = ruled.fields[f];
        else delete fields[f];
    }
    const fromRules = [];
    for (const [field, value] of Object.entries(ruled.fields)) {
        if (!(field in fields) && value) {
            fields[field] = value;
            fromRules.push(field);
        }
    }
    // Separate names from the model beat a combined one from the rules.
    if (fields.surname && fromRules.includes('full_name')) {
        delete fields.full_name;
        fromRules.splice(fromRules.indexOf('full_name'), 1);
    }
    return {fields, card_type: modelOut.card_type || ruled.card_type, confidence: modelOut.confidence, from_rules: fromRules};
}

// ----- Training -----

/** Which line holds each labelled value: the class of every line (a field, or "other"). */
function lineTargets(lines, label, profile) {
    const classes = lines.map(() => OTHER);
    for (const field of profile.fields) {
        const want = label.fields && label.fields[field];
        if (!want) continue;
        const wanted = profile.normalise(field, want) || String(want).toUpperCase();
        const i = lines.findIndex((l, idx) => classes[idx] === OTHER &&
            (profile.normalise(field, stripLabel(l.text, profile.labels[field])) === wanted || profile.normalise(field, l.text) === wanted));
        if (i >= 0) classes[i] = field;
    }
    return classes;
}

/** Same value? Names and dates are compared after the country's own normalising. */
function same(profile, field, got, want) {
    if (!want) return !got;
    if (!got) return false;
    return (profile.normalise(field, got) || got) === (profile.normalise(field, want) || String(want).toUpperCase());
}

/**
 * How often `read` gets each field right on `samples` ({lines, label}). Only fields the label gives are
 * counted. Returns {fields: {field: {correct, total, accuracy}}, card_type: {…}, overall}.
 */
function evaluate(samples, profile, read) {
    const tally = Object.fromEntries(profile.fields.map((f) => [f, {correct: 0, total: 0}]));
    const cards = {correct: 0, total: 0};
    for (const s of samples) {
        const out = read(s.lines);
        for (const field of profile.fields) {
            if (!s.label.fields || !s.label.fields[field]) continue;
            tally[field].total++;
            if (same(profile, field, out.fields[field], s.label.fields[field])) tally[field].correct++;
        }
        if (s.label.card_type) {
            cards.total++;
            if (out.card_type === s.label.card_type) cards.correct++;
        }
    }
    const acc = (t) => (t.total ? Math.round((t.correct / t.total) * 1000) / 1000 : null);
    let correct = 0;
    let total = 0;
    for (const t of Object.values(tally)) {
        correct += t.correct;
        total += t.total;
        t.accuracy = acc(t);
    }
    cards.accuracy = acc(cards);
    return {fields: tally, card_type: cards, overall: total ? Math.round((correct / total) * 1000) / 1000 : null};
}

/**
 * Trains a country's model on labelled samples ({lines, label: {card_type, fields}, source?}), holds 20%
 * back to test it against the rules, and returns the model, ready to save. `active` says whether to use it.
 *
 * Samples with `source: "synthetic"` are drawn cards (tools/idcard-synth). They're trained on, but when
 * there are enough real scans (10+), only real ones are held back for the test, so the score says how it
 * does on real cards. A model tested only on drawn cards isn't made active unless `activateSynthetic`.
 */
function train(samples, profile, {version = 1, now = new Date(), testShare = 0.2, activateSynthetic = false} = {}) {
    if (!samples.length) throw new Error('no labelled scans to train on');
    const real = shuffled(samples.filter((s) => s.source !== 'synthetic'));
    const synthetic = shuffled(samples.filter((s) => s.source === 'synthetic'));
    const testFrom = real.length >= 10 ? real : shuffled(samples);
    const testCount = testFrom.length >= 10 ? Math.max(1, Math.round(testFrom.length * testShare)) : 0;
    const test = testFrom.slice(0, testCount);
    const held = new Set(test);
    const trainSet = samples.filter((s) => !held.has(s));
    const testedOnReal = test.length > 0 && test.every((s) => s.source !== 'synthetic');

    const fieldClasses = [...profile.fields, OTHER];
    const X = [];
    const y = [];
    for (const s of trainSet) {
        const targets = lineTargets(s.lines, s.label, profile);
        features.lineFeatures(s.lines, profile).forEach((x, i) => {
            X.push(x);
            y.push(targets[i]);
        });
    }
    const field_model = trainSoftmax(X, y, fieldClasses);

    const typed = trainSet.filter((s) => profile.cardTypes.includes(s.label.card_type));
    const seenTypes = [...new Set(typed.map((s) => s.label.card_type))];
    const card_model = seenTypes.length >= 2
        ? trainSoftmax(typed.map((s) => features.cardFeatures(s.lines, profile)), typed.map((s) => s.label.card_type), profile.cardTypes)
        : null;

    const model = {country: profile.code, version, feature_version: features.VERSION, trained_at: now.toISOString(), field_model, card_model};
    const evalSet = test.length ? test : trainSet;
    // Scored as cards are really read (helpers/idcard/index.js): the ID number always comes from the rules.
    const asRead = (lines) => combine(profile, extract(model, lines, profile), profile.rules(lines));
    const modelMetrics = evaluate(evalSet, profile, asRead);
    const rulesMetrics = evaluate(evalSet, profile, (lines) => profile.rules(lines));
    const enough = trainSet.length >= minSamples() && test.length > 0;
    const better = modelMetrics.overall !== null && modelMetrics.overall >= (rulesMetrics.overall || 0);
    return {
        ...model,
        active: enough && better && (testedOnReal || activateSynthetic),
        samples: {train: trainSet.length, test: test.length, real: real.length, synthetic: synthetic.length, min_needed: minSamples()},
        metrics: {
            model: modelMetrics,
            rules: rulesMetrics,
            tested_on: !test.length ? 'training_set' : testedOnReal ? 'held_out' : 'held_out_with_synthetic',
        },
    };
}

// ----- The saved models -----

const cache = new Map();

/** The country's saved model, or null. Cached; reload() reads the files again. */
function load(country) {
    const key = String(country).toUpperCase();
    if (cache.has(key)) return cache.get(key);
    let model = null;
    try {
        model = JSON.parse(fs.readFileSync(path.join(modelDir(), `${key}.json`), 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Could not load the ${key} ID card model:`, err.message);
    }
    cache.set(key, model);
    return model;
}

/** The model to read with: saved, active and built on the current features. Otherwise null (use the rules). */
function usable(country) {
    const m = load(country);
    return m && m.active && m.feature_version === features.VERSION ? m : null;
}

function reload() {
    cache.clear();
}

/** Writes the model to config/id-models/<COUNTRY>.json, keeping the previous one as <COUNTRY>.v<n>.json. */
function save(model) {
    const dir = modelDir();
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${model.country}.json`);
    if (fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, path.join(dir, `${model.country}.v${old.version}.json`));
    }
    fs.writeFileSync(file, JSON.stringify(model));
    cache.delete(model.country);
    return file;
}

/** What's known about a country's model, without its weights. */
function summary(country) {
    const m = load(country);
    if (!m) return null;
    return {
        version: m.version,
        active: Boolean(m.active),
        usable: Boolean(usable(country)),
        trained_at: m.trained_at,
        feature_version: m.feature_version,
        samples: m.samples,
        metrics: m.metrics,
    };
}

module.exports = {trainSoftmax, predict, extract, combine, lineTargets, evaluate, train, load, usable, reload, save, summary, OTHER};
