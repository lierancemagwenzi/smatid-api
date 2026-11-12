/**
 * Zimbabwe's national ID cards: the old metal card and the plastic (laminated paper) card. Both carry the
 * same national registration number:
 *
 *   63-1234567 A 42
 *   │   │      │ └ district of origin
 *   │   │      └ check letter
 *   │   └ serial (6 or 7 digits)
 *   └ district where the person was registered
 *
 * The rules below read a card with no trained model. Once enough scans are labelled, a model trained on
 * them (helpers/idcard/model.js) takes over; these rules stay as the fallback and the bar it must beat.
 */
const {parseDate, age, cleanName, stripLabel, TO_DIGIT} = require('../common');

const code = 'ZW';
const name = 'Zimbabwe';
const cardTypes = ['metal', 'plastic'];

/**
 * Fields read by pattern rather than by place: the ID number (with its check letter) and what follows it
 * ("CIT M"). Taken from the rules even when a model reads the card.
 */
const ruleFields = ['id_number', 'id_number_letter_inferred', 'sex', 'citizenship'];

/** What can be read off the front of the card, in the order the result lists them. */
const fields = ['id_number', 'surname', 'first_names', 'date_of_birth', 'place_of_birth', 'village_of_origin', 'sex', 'date_of_issue'];

/**
 * The printed labels, by field. Matched at the start of a line, case aside. Loose on purpose: the labels are
 * small capitals and OCR misreads them ("PLACE OF BATH", "VILLAGE OF ORION", "ID Nussen"), and a label
 * that isn't recognised would be taken for a value.
 */
const labels = {
    id_number: /(?:NATIONAL\s*)?I\.?\s*D\.?\s*N[A-Z]*\.?|NATIONAL\s*REG(?:ISTRATION)?\s*(?:NO|NUMBER)\.?/,
    surname: /SUR\s*NAME|LAST\s*NAME/,
    // "FIRST NANE", "FIRST NAMF": OCR's M/N mix-ups in the small capitals.
    first_names: /FIRST\s*N[A-Z]{2,3}S?\b|FORENAMES?|GIVEN\s*NAMES?|OTHER\s*NAMES?/,
    date_of_birth: /DATE\s*O[FP]?\s*B[A-Z]*|D\.\s*O\.\s*B\.?|BIRTH\s*DATE/,
    place_of_birth: /PLACE\s*O[FP]?\s*B[A-Z]*/,
    // "VLLAGE OF ORIGIN": the I lost.
    village_of_origin: /V[IL1]{2,3}AGE(?:\s*O[FP]?\s*OR[A-Z]{2,4})?/,
    sex: /SEX|GENDER/,
    date_of_issue: /DATE\s*O[FP]?\s*I[A-Z]*|ISSUE\s*DATE|DATE\s*ISSUED/,
};

/** Words printed on the card that are never a person's details. */
const noise = /\b(REPUBLIC|ZIMBABWE|NATIONAL|REGISTRATION|IDENTITY|IDENTIFICATION|CARD|REGISTRAR|GENERAL|SIGNATURE|HOLDER|OFFICER|DOCUMENT|CITIZEN|NATIONALITY)\b/;

/** Words that point to one kind of card, for the rules' guess and as model features. */
const cardTypeHints = {
    plastic: /REGISTRAR\s*GENERAL|PLACE\s*OF\s*BIRTH|VILLAGE\s*OF\s*ORIGIN|DATE\s*OF\s*ISSUE/,
};

// ----- The ID number -----

// Check letters: the number mod 23. No I, O or U.
const CHECK_LETTERS = 'ZABCDEFGHJKLMNPQRSTVWXY';
// A check letter read as a digit.
const TO_LETTER = {0: 'D', 2: 'Z', 5: 'S', 6: 'G', 8: 'B'};

const D = '[0-9OQDILTZSGB|]';
const STRICT = new RegExp(`(?<![0-9])(${D}{2})-?(${D}{6,7})([A-Z])(${D}{2})(?![0-9])`);
// After the number the plastic card prints the holder's citizenship and sex: "63-2216219 R 42 CIT F".
const SUFFIX = /\b(N?CIT|ALIEN|ALN)\s*([MF])\b/;
const LOOSE = new RegExp(`(?<![0-9])(${D}{2})-?(${D}{6,7})([A-Z0-9])(${D}{2})(?![0-9])`);

// The check letter read as a dash-free number, with the letter lost (glare, or OCR skipping a lone letter).
const NO_LETTER = new RegExp(`(?<![0-9])(${D}{2})-(${D}{6,7})[^A-Z0-9]{1,4}(${D}{2})(?![0-9])`);

// Symbols OCR reads for letters.
const LOOKALIKE = {'₽': 'P', '€': 'E', '$': 'S', '£': 'L', '¥': 'Y', '§': 'S', '¢': 'C', 'Ø': 'O'};

const toDigits = (s) => s.split('').map((c) => TO_DIGIT[c] || c).join('');

/** The check letter the district and serial should carry. */
function expectedCheckLetter(district, serial) {
    return CHECK_LETTERS[Number(BigInt(district + serial) % 23n)];
}

/**
 * The first ID number in the text, or null: {value: "63-1234567 A 42", district, serial, check_letter,
 * origin_district, check_letter_valid, expected_check_letter, corrected}. `corrected` says OCR look-alikes
 * were changed (an O read for a 0, …).
 */
function parseIdNumber(text, {inferLetter = false} = {}) {
    const upper = String(text || '').toUpperCase().replace(/[₽€$£¥§¢Ø]/g, (c) => LOOKALIKE[c]).replace(/[–—_~=]/g, '-');
    const compact = upper.replace(/\s+/g, '');
    const m = compact.match(STRICT) || compact.match(LOOSE);
    if (!m) return inferLetter ? withInferredLetter(upper) : null;
    const suffix = upper.match(SUFFIX);
    const district = toDigits(m[1]);
    const serial = toDigits(m[2]);
    const origin = toDigits(m[4]);
    if (!/^\d{2}$/.test(district) || !/^\d{6,7}$/.test(serial) || !/^\d{2}$/.test(origin)) return null;
    const letter = /[0-9]/.test(m[3]) ? TO_LETTER[m[3]] : m[3];
    if (!letter) return null;
    const expected = expectedCheckLetter(district, serial);
    return {
        value: `${district}-${serial} ${letter} ${origin}`,
        district,
        serial,
        check_letter: letter,
        origin_district: origin,
        check_letter_valid: letter === expected,
        expected_check_letter: expected,
        corrected: `${district}${serial}${letter}${origin}` !== `${m[1]}${m[2]}${m[3]}${m[4]}`,
        citizenship: suffix ? suffix[1] : null,
        sex: suffix ? suffix[2] : null,
    };
}

/**
 * "47-6166061 77": the check letter wasn't read. It's worked out from the number, so it proves nothing
 * about the read: `check_letter_inferred` sends the scan to review.
 */
function withInferredLetter(upper) {
    const m = upper.match(NO_LETTER);
    if (!m) return null;
    const district = toDigits(m[1]);
    const serial = toDigits(m[2]);
    const origin = toDigits(m[3]);
    if (!/^\d{2}$/.test(district) || !/^\d{6,7}$/.test(serial) || !/^\d{2}$/.test(origin)) return null;
    const letter = expectedCheckLetter(district, serial);
    return {
        value: `${district}-${serial} ${letter} ${origin}`, district, serial, check_letter: letter, origin_district: origin,
        check_letter_valid: true, expected_check_letter: letter, corrected: true, check_letter_inferred: true,
    };
}

// ----- Values -----

/** A field's value from a line of text (its label already taken off), or null if it doesn't fit. */
function normalise(field, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    switch (field) {
        case 'id_number': {
            const id = parseIdNumber(t);
            return id ? id.value : null;
        }
        case 'date_of_birth':
        case 'date_of_issue':
            return parseDate(t);
        case 'sex': {
            const m = t.toUpperCase().match(/\b(M|F|MALE|FEMALE)\b/);
            return m ? m[1][0] : null;
        }
        default: {
            if (/\d{3,}/.test(t) || noise.test(t.toUpperCase())) return null;
            if (Object.values(labels).some((re) => new RegExp(`^\\s*(?:${re.source})\\s*[:.]?\\s*$`, 'i').test(t))) return null;
            return cleanName(t);
        }
    }
}

/** The field whose label starts this line, if any. */
function labelOf(text) {
    for (const field of fields) {
        if (new RegExp(`^\\s*(?:${labels[field].source})`, 'i').test(text)) return field;
    }
    return null;
}

// ----- The rules -----

/** The ID number among the lines: {id, line}, or null. A read letter beats a worked-out one. */
function findIdNumber(lines) {
    // Each line alone, then with the next one or two to its right on the same row.
    const tries = lines.map((line) => {
        const right = lines.filter((l) => l.row === line.row && l.box[0] > line.box[0]).sort((a, b) => a.box[0] - b.box[0]);
        return {line, texts: [line.text, ...[1, 2].filter((n) => n <= right.length).map((n) => [line, ...right.slice(0, n)].map((l) => l.text).join(' '))]};
    });
    for (const inferLetter of [false, true]) {
        for (const {line, texts} of tries) {
            for (const text of texts) {
                const id = parseIdNumber(text, {inferLetter});
                if (id) return {id, line};
            }
        }
    }
    return null;
}

/**
 * Reads the card from its OCR lines (sorted, from ocrInput.parse) without a model.
 * Returns {fields: {…}, card_type, lines: {field: line index}}.
 */
function rules(lines) {
    const out = {};
    const used = new Map();
    const take = (field, value, line) => {
        if (value === null || value === undefined || out[field]) return false;
        out[field] = value;
        used.set(line.index, field);
        return true;
    };
    const labelLines = new Set(lines.filter((l) => labelOf(l.text)).map((l) => l.index));

    // Labelled values: on the label's own line, else the nearest line to its right or below it.
    for (const line of lines) {
        const field = labelOf(line.text);
        if (!field || out[field]) continue;
        if (take(field, normalise(field, stripLabel(line.text, labels[field])), line)) continue;
        const h = line.box[3] || 0.03;
        const candidates = lines
            .filter((l) => l.index !== line.index && !used.has(l.index) && !labelLines.has(l.index))
            .map((l) => {
                // To its right on the same row, or beside it a little higher or lower (OCR then puts them in
                // different rows: "MOYO" read just above "SURNAME").
                const mid = (b) => b[1] + b[3] / 2;
                const sameRow = l.box[0] > line.box[0] && (l.row === line.row || Math.abs(mid(l.box) - mid(line.box)) < h * 0.6);
                const dy = l.box[1] - (line.box[1] + line.box[3]);
                const below = dy > -h / 2 && dy < h * 3 && Math.abs(l.box[0] - line.box[0]) < 0.2;
                return {l, d: sameRow ? l.box[0] - line.box[0] : below ? 1 + dy : Infinity};
            })
            .filter((c) => c.d < Infinity)
            .sort((a, b) => a.d - b.d);
        for (const {l} of candidates) {
            if (take(field, normalise(field, l.text), l)) break;
        }
    }

    // The number is printed on every card, labelled or not. OCR often splits it ("24-3763637 Z" and "29"),
    // so each line is also tried with the lines to its right on the same row.
    let idInferred = false;
    const found = findIdNumber(lines);
    if (found && !out.id_number) {
        take('id_number', found.id.value, found.line);
        idInferred = Boolean(found.id.check_letter_inferred);
    }
    // "… CIT M" after the number: the holder's citizenship and sex.
    if (found && found.id.value === out.id_number) {
        if (found.id.sex && !out.sex) out.sex = found.id.sex;
        if (found.id.citizenship) out.citizenship = found.id.citizenship;
    }

    // Dates no label claimed: on the metal card (no labels), or where OCR put a value above its label.
    // The earliest is the birth date; the latest after it, the date of issue.
    const dates = lines
        .filter((l) => !used.has(l.index))
        .map((l) => ({l, date: parseDate(l.text)}))
        .filter((d) => d.date)
        .sort((a, b) => a.date.localeCompare(b.date));
    if (!out.date_of_birth && dates.length) {
        const first = dates.shift();
        take('date_of_birth', first.date, first.l);
    }
    const later = dates.filter((d) => !out.date_of_birth || d.date > out.date_of_birth);
    if (!out.date_of_issue && later.length) take('date_of_issue', later[later.length - 1].date, later[later.length - 1].l);

    // Unlabelled names: the first lines of only letters after the ID number. Which is the surname isn't
    // known without labels, so they're given as the full name.
    const result = {...out};
    if (!out.surname && !out.first_names) {
        const idLine = [...used.entries()].find(([, f]) => f === 'id_number');
        const after = idLine ? idLine[0] : -1;
        const names = lines.filter((l) => l.index > after && !used.has(l.index) && !labelLines.has(l.index) && normalise('surname', l.text));
        if (names.length) {
            result.full_name = names.slice(0, 2).map((l) => normalise('surname', l.text)).join(' ');
            used.set(names[0].index, 'full_name');
        }
    }

    if (idInferred) result.id_number_letter_inferred = true;
    const all = lines.map((l) => l.text).join(' ').toUpperCase();
    const card_type = labelLines.size >= 2 || cardTypeHints.plastic.test(all) ? 'plastic' : 'metal';
    return {fields: result, card_type, lines: Object.fromEntries([...used.entries()].map(([i, f]) => [f, i]))};
}

// ----- Checking what was read -----

const strictCheckLetter = () => process.env.ZW_CHECK_LETTER_STRICT === '1';

/**
 * Whether the card's details hold together. Returns {document, checks, status, failure_reason,
 * review_reasons}, or null when no ID number was read (the app should scan again).
 *
 * A wrong check letter is a "review" unless ZW_CHECK_LETTER_STRICT=1: OCR misreading a letter looks the
 * same as a made-up number.
 */
function check(read, {now = new Date()} = {}) {
    const f = read.fields || {};
    const id = f.id_number ? parseIdNumber(f.id_number) : null;
    if (!id) return null;
    // The letter wasn't read but worked out from the number: it can't vouch for the read.
    const inferred = Boolean(f.id_number_letter_inferred);

    const surname = f.surname || null;
    const firstNames = f.first_names || null;
    const fullName = firstNames && surname ? `${firstNames} ${surname}` : f.full_name || surname || firstNames || null;
    const document = {
        country: code,
        card_type: read.card_type || null,
        id_number: id.value,
        id_number_parts: {district: id.district, serial: id.serial, check_letter: id.check_letter, origin_district: id.origin_district},
        surname,
        first_names: firstNames,
        full_name: fullName,
        date_of_birth: f.date_of_birth || null,
        place_of_birth: f.place_of_birth || null,
        village_of_origin: f.village_of_origin || null,
        sex: f.sex || null,
        citizenship: f.citizenship || null,
        date_of_issue: f.date_of_issue || null,
    };

    const years = document.date_of_birth ? age(document.date_of_birth, now) : null;
    const checks = {
        id_number_format: true,
        id_check_letter: inferred ? null : id.check_letter_valid,
        name_found: Boolean(fullName),
        date_of_birth_found: Boolean(document.date_of_birth),
        date_of_birth_plausible: years === null ? null : years >= 0 && years <= 125,
        issue_after_birth: document.date_of_birth && document.date_of_issue ? document.date_of_issue >= document.date_of_birth : null,
    };

    let failure = null;
    if (checks.date_of_birth_plausible === false) failure = 'invalid_date_of_birth';
    else if (!inferred && !id.check_letter_valid && strictCheckLetter()) failure = 'id_check_letter_mismatch';

    const review = [];
    if (inferred) review.push('check_letter_not_read');
    else if (!id.check_letter_valid) review.push('check_letter_mismatch');
    if (!checks.name_found) review.push('name_missing');
    if (!document.surname && fullName) review.push('surname_not_separated');
    if (!checks.date_of_birth_found) review.push('date_of_birth_missing');
    if (checks.issue_after_birth === false) review.push('issued_before_birth');

    return {
        document,
        checks,
        status: failure ? 'failed' : review.length ? 'review' : 'passed',
        failure_reason: failure,
        review_reasons: failure ? [] : review,
    };
}

module.exports = {code, name, cardTypes, ruleFields, fields, labels, noise, cardTypeHints, labelOf, normalise, parseIdNumber, findIdNumber, expectedCheckLetter, rules, check};
