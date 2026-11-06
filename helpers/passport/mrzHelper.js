/**
 * Reads the machine-readable zone (MRZ) of a passport: the two 44-character lines at the bottom of the
 * photo page (ICAO 9303 "TD3"). The phone reads the text; this decides what it says and whether it holds
 * together, so a misread never reaches the client as a passport.
 *
 *   P<ZWEMOYO<<TARIRO<GRACE<<<<<<<<<<<<<<<<<<<<<
 *   FN1234567ZWE9003124F3101015<<<<<<<<<<<<<<04
 */

const LINE = 44;

// What OCR mixes up. Only used where the character type is fixed: digits in dates and check digits,
// letters in country codes and names. Document numbers can hold both, so they're left as read.
const TO_DIGIT = {O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', G: '6', B: '8'};
const TO_LETTER = {0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B'};

/** Uppercase, no spaces, and the look-alikes of the filler character turned into "<". */
function clean(line) {
    return String(line || '')
        .toUpperCase()
        .replace(/[\s]/g, '')
        .replace(/[«‹(\[{]/g, '<')
        .replace(/[^A-Z0-9<]/g, '<');
}

/** ICAO 9303 check digit: weights 7, 3, 1; digits as themselves, A-Z as 10-35, "<" as 0. */
function checkDigit(value) {
    let sum = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        let n;
        if (c >= '0' && c <= '9') n = c.charCodeAt(0) - 48;
        else if (c >= 'A' && c <= 'Z') n = c.charCodeAt(0) - 55;
        else n = 0;
        sum += n * [7, 3, 1][i % 3];
    }
    return String(sum % 10);
}

const digits = (s) => s.split('').map((c) => TO_DIGIT[c] || c).join('');
const letters = (s) => s.split('').map((c) => TO_LETTER[c] || c).join('');
// A check digit of "<" stands for an empty field, which counts as 0.
const checkChar = (c) => (c === '<' ? '<' : digits(c));
const checkMatches = (field, c) => (c === '<' ? /^<*$/.test(field) || checkDigit(field) === '0' : checkDigit(field) === c);

/** YYMMDD as YYYY-MM-DD. Birth dates in the future belong to the last century; expiry dates don't. */
function toDate(yymmdd, kind, now = new Date()) {
    if (!/^\d{6}$/.test(yymmdd)) return null;
    const yy = Number(yymmdd.slice(0, 2));
    const mm = Number(yymmdd.slice(2, 4));
    const dd = Number(yymmdd.slice(4, 6));
    const thisYear = now.getUTCFullYear() % 100;
    const century = kind === 'birth' ? (yy > thisYear ? 1900 : 2000) : (yy >= 70 ? 1900 : 2000);
    const year = century + yy;
    const date = new Date(Date.UTC(year, mm - 1, dd));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
    return date.toISOString().slice(0, 10);
}

/**
 * A birth date where parts may be unknown. ICAO 9303 fills an unknown day, month or year with "<";
 * some countries use "X". Returns {date, partial}: date is YYYY-MM-DD, YYYY-MM or YYYY (the forms the
 * sanctions check takes), or null when the year isn't known. Returns null when the field doesn't make
 * sense (a half-filled part, month 13, 31 February).
 */
function toBirthDate(field, now = new Date()) {
    const parts = [field.slice(0, 2), field.slice(2, 4), field.slice(4, 6)];
    const unknown = (p) => /^[<X]{2}$/.test(p);
    if (parts.some((p) => !/^\d{2}$/.test(p) && !unknown(p))) return null;
    if (!parts.some(unknown)) {
        const date = toDate(field, 'birth', now);
        return date ? {date, partial: false} : null;
    }
    const [yy, mm, dd] = parts;
    if (!unknown(mm) && (Number(mm) < 1 || Number(mm) > 12)) return null;
    if (!unknown(dd)) {
        // A known day needs to fit its month, or any month if that isn't known either (so up to 31).
        const days = unknown(mm) ? 31 : new Date(Date.UTC(2000, Number(mm), 0)).getUTCDate();
        if (Number(dd) < 1 || Number(dd) > days) return null;
    }
    if (unknown(yy)) return {date: null, partial: true};
    const year = (Number(yy) > now.getUTCFullYear() % 100 ? 1900 : 2000) + Number(yy);
    if (unknown(mm)) return {date: String(year), partial: true};
    // Only the day is unknown.
    return {date: `${year}-${mm}`, partial: true};
}

/** "MOYO<<TARIRO<GRACE<<<" as surname MOYO and given names TARIRO GRACE. */
function names(field) {
    const fixed = letters(field);
    const [surname, ...rest] = fixed.split('<<');
    const tidy = (s) => s.replace(/<+/g, ' ').trim();
    return {
        surname: tidy(surname),
        given_names: tidy(rest.join('<<')),
        // A name that fills the whole field may have been cut short to fit.
        truncated: !/<$/.test(field),
    };
}

/**
 * Picks the two MRZ lines out of whatever text was read: either exactly two lines, or a block of
 * lines (e.g. everything OCR found on the page) in which they appear together.
 */
function findLines(input) {
    const lines = (Array.isArray(input) ? input : String(input || '').split(/\r?\n/)).map(clean).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i++) {
        const a = lines[i];
        const b = lines[i + 1];
        if (/^P[A-Z0-9<]/.test(a) && Math.abs(a.length - LINE) <= 2 && Math.abs(b.length - LINE) <= 2) {
            return [a, b];
        }
    }
    return null;
}

/** Pads or trims a line to 44 characters. Missing filler at the end is a common misread. */
const fit = (line) => (line.length >= LINE ? line.slice(0, LINE) : line + '<'.repeat(LINE - line.length));

/**
 * Parses a passport MRZ. Returns {valid, format, fields, checks, problems, lines}, where `valid` means every
 * check digit matched. Throws nothing: bad input comes back as valid: false with a problem.
 */
function parse(input, {now = new Date()} = {}) {
    const found = findLines(input);
    if (!found) return {valid: false, format: null, fields: null, checks: null, problems: ['mrz_not_found'], lines: null};

    const l1 = fit(found[0]);
    const raw2 = fit(found[1]);

    // Line 2, with digits forced where only digits may be.
    const docNumber = raw2.slice(0, 9);
    const docCheck = checkChar(raw2[9]);
    const nationality = letters(raw2.slice(10, 13));
    const birth = digits(raw2.slice(13, 19));
    const birthCheck = checkChar(raw2[19]);
    const sex = {M: 'M', F: 'F', '<': 'X', X: 'X'}[raw2[20]] || null;
    const expiry = digits(raw2.slice(21, 27));
    const expiryCheck = checkChar(raw2[27]);
    const optional = raw2.slice(28, 42);
    const optionalCheck = checkChar(raw2[42]);
    const compositeCheck = checkChar(raw2[43]);
    const l2 = docNumber + docCheck + nationality + birth + birthCheck + raw2[20] + expiry + expiryCheck + optional + optionalCheck + compositeCheck;

    const composite = docNumber + docCheck + birth + birthCheck + expiry + expiryCheck + optional + optionalCheck;
    const checks = {
        document_number: checkMatches(docNumber, docCheck),
        birth_date: checkMatches(birth, birthCheck),
        expiry_date: checkMatches(expiry, expiryCheck),
        personal_number: checkMatches(optional, optionalCheck),
        composite: checkMatches(composite, compositeCheck),
    };

    const issuing = letters(l1.slice(2, 5));
    const person = names(l1.slice(5));
    const birthDate = toBirthDate(birth, now);
    const expiryDate = toDate(expiry, 'expiry', now);

    const problems = [];
    if (l1[0] !== 'P') problems.push('not_a_passport');
    for (const [name, ok] of Object.entries(checks)) if (!ok) problems.push(`${name}_check_failed`);
    if (!birthDate) problems.push('birth_date_invalid');
    if (!expiryDate) problems.push('expiry_date_invalid');
    if (!/^[A-Z<]{3}$/.test(issuing)) problems.push('issuing_country_invalid');
    if (!/^[A-Z<]{3}$/.test(nationality)) problems.push('nationality_invalid');
    if (!person.surname) problems.push('name_missing');

    const today = now.toISOString().slice(0, 10);
    return {
        valid: problems.length === 0,
        format: 'TD3',
        fields: {
            document_type: l1.slice(0, 2).replace(/</g, ''),
            issuing_country: issuing.replace(/</g, ''),
            surname: person.surname,
            given_names: person.given_names,
            name_truncated: person.truncated,
            document_number: docNumber.replace(/</g, ''),
            nationality: nationality.replace(/</g, ''),
            // YYYY-MM-DD, or YYYY-MM / YYYY / null when the passport says part of it isn't known.
            birth_date: birthDate ? birthDate.date : null,
            birth_date_partial: birthDate ? birthDate.partial : false,
            sex,
            expiry_date: expiryDate,
            expired: expiryDate ? expiryDate < today : null,
            personal_number: optional.replace(/</g, '') || null,
        },
        checks,
        problems,
        lines: [l1.slice(0, 2) + issuing + letters(l1.slice(5)), l2],
    };
}

module.exports = {parse, checkDigit, findLines, clean, toDate, toBirthDate};
