/**
 * ID cards, by country. Each country is a profile in helpers/idcard/countries/ (its fields, labels, ID
 * number rules and checks) plus, once trained, a model in config/id-models/. Adding a country means
 * adding its profile, collecting and labelling its scans, and training.
 */
const model = require('./model');

const countries = {
    ZW: require('./countries/zw'),
};

// ISO 3166 alpha-3 codes some callers use.
const ALPHA3 = {ZWE: 'ZW'};

/** The profile for "ZW", "zw" or "ZWE", or null if the country isn't supported. */
function profile(country) {
    const c = String(country || '').trim().toUpperCase();
    return countries[ALPHA3[c] || c] || null;
}

/**
 * Reads a card's OCR lines (from ocrInput.parse). Uses the country's model when there's a usable one;
 * fields the model didn't find are filled from the rules, and named in `from_rules`.
 * Returns {fields, card_type, extracted_by, confidence, from_rules}.
 */
function read(p, lines) {
    const ruled = p.rules(lines);
    const m = model.usable(p.code);
    if (!m) return {fields: ruled.fields, card_type: ruled.card_type, extracted_by: `rules:${p.code}`, confidence: null, from_rules: []};

    const out = model.combine(p, model.extract(m, lines, p), ruled);
    return {...out, extracted_by: `model:${p.code}@${m.version}`};
}

const supported = () => Object.values(countries).map((p) => ({code: p.code, name: p.name, card_types: p.cardTypes, fields: p.fields}));

module.exports = {profile, read, supported, countries};
