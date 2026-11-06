/**
 * Checks what a phone read from a passport chip (ICAO 9303 part 11 "passive authentication"):
 *
 *   1. EF.SOD lists a hash of every data group. Each file the phone sent must hash to its entry.
 *   2. The list is signed by the issuing country's Document Signer (DS), whose certificate is in EF.SOD.
 *   3. That certificate must be issued by the country's CSCA, from our own store (config/csca/).
 *
 * 1 and 2 show the data hasn't been changed since it was signed. 3 shows who signed it. None of them
 * show the chip isn't a copy: that needs chip or active authentication, which come later.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const der = require('./derHelper');
const mrzHelper = require('./mrzHelper');

const OID = {
    signedData: '1.2.840.113549.1.7.2',
    ldsSecurityObject: '2.23.136.1.1.1',
    messageDigest: '1.2.840.113549.1.9.4',
    rsaPss: '1.2.840.113549.1.1.10',
    cscaMasterList: '2.23.136.1.1.2',
};

const DIGESTS = {
    '1.3.14.3.2.26': 'sha1',
    '2.16.840.1.101.3.4.2.4': 'sha224',
    '2.16.840.1.101.3.4.2.1': 'sha256',
    '2.16.840.1.101.3.4.2.2': 'sha384',
    '2.16.840.1.101.3.4.2.3': 'sha512',
};

// Signature algorithms: [scheme, digest]. A null digest means "the signer info's digest algorithm".
const SIGNATURES = {
    '1.2.840.113549.1.1.1': ['rsa', null],
    '1.2.840.113549.1.1.5': ['rsa', 'sha1'],
    '1.2.840.113549.1.1.14': ['rsa', 'sha224'],
    '1.2.840.113549.1.1.11': ['rsa', 'sha256'],
    '1.2.840.113549.1.1.12': ['rsa', 'sha384'],
    '1.2.840.113549.1.1.13': ['rsa', 'sha512'],
    '1.2.840.113549.1.1.10': ['pss', null],
    '1.2.840.10045.2.1': ['ecdsa', null],
    '1.2.840.10045.4.1': ['ecdsa', 'sha1'],
    '1.2.840.10045.4.3.1': ['ecdsa', 'sha224'],
    '1.2.840.10045.4.3.2': ['ecdsa', 'sha256'],
    '1.2.840.10045.4.3.3': ['ecdsa', 'sha384'],
    '1.2.840.10045.4.3.4': ['ecdsa', 'sha512'],
    // BSI TR-03111 "plain" ECDSA (r || s), used by German and some other passports.
    '0.4.0.127.0.7.1.1.4.1.1': ['ecdsa-plain', 'sha1'],
    '0.4.0.127.0.7.1.1.4.1.2': ['ecdsa-plain', 'sha224'],
    '0.4.0.127.0.7.1.1.4.1.3': ['ecdsa-plain', 'sha256'],
    '0.4.0.127.0.7.1.1.4.1.4': ['ecdsa-plain', 'sha384'],
    '0.4.0.127.0.7.1.1.4.1.5': ['ecdsa-plain', 'sha512'],
};

// Data group file tags, by number.
const DG_TAGS = {1: 0x61, 2: 0x75, 14: 0x6e, 15: 0x6f};

class ChipDataError extends Error {
    constructor(message) {
        super(message);
        this.code = 'chip_data_invalid';
    }
}

const hash = (algorithm, data) => crypto.createHash(algorithm).update(data).digest();

/** An AlgorithmIdentifier's OID and its parameters node (or null). */
function algorithm(node) {
    return {oid: node.child(0, 0x06).oid, params: node.children[1] || null};
}

// ----- EF.SOD -----

/**
 * Takes EF.SOD apart. Throws ChipDataError if it isn't one.
 * Returns the hash list, the signer's certificate and what's needed to check the signature.
 */
function parseSod(sodBytes) {
    try {
        let root = der.parse(sodBytes);
        // EF.SOD wraps the CMS ContentInfo in tag 0x77.
        if (root.tag === 0x77) root = root.child(0, 0x30);
        if (root.child(0, 0x06).oid !== OID.signedData) throw new ChipDataError('EF.SOD is not CMS signed data');
        const signedData = root.child(1, 0xa0).child(0, 0x30);

        const encap = signedData.child(2, 0x30);
        if (encap.child(0, 0x06).oid !== OID.ldsSecurityObject) throw new ChipDataError('EF.SOD does not hold an LDS security object');
        const eContent = encap.child(1, 0xa0).child(0, 0x04).value;
        const lds = der.parse(eContent);
        const ldsHash = DIGESTS[algorithm(lds.child(1, 0x30)).oid];
        if (!ldsHash) throw new ChipDataError('unsupported data group hash algorithm');
        const hashes = {};
        for (const entry of lds.child(2, 0x30).children) {
            hashes[entry.child(0, 0x02).int] = Buffer.from(entry.child(1, 0x04).value);
        }

        // certificates [0] IMPLICIT: the Document Signer certificate.
        const certs = signedData.find(0xa0);
        if (!certs || !certs.children.length) throw new ChipDataError('EF.SOD has no signer certificate');
        const signerInfos = signedData.children[signedData.children.length - 1];
        if (signerInfos.tag !== 0x31 || !signerInfos.children.length) throw new ChipDataError('EF.SOD has no signer');
        const si = signerInfos.child(0, 0x30);
        // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature
        const digest = DIGESTS[algorithm(si.child(2, 0x30)).oid];
        if (!digest) throw new ChipDataError('unsupported signer digest algorithm');
        const signedAttrs = si.child(3, 0xa0);
        const sigAlg = algorithm(si.child(4, 0x30));
        const signature = Buffer.from(si.child(5, 0x04).value);

        let messageDigest = null;
        for (const attr of signedAttrs.children) {
            if (attr.child(0, 0x06).oid === OID.messageDigest) messageDigest = Buffer.from(attr.child(1, 0x31).child(0, 0x04).value);
        }
        if (!messageDigest) throw new ChipDataError('EF.SOD has no message digest');

        // What was signed is the signed attributes encoded as a SET (tag 0x31), not as [0].
        const signedBytes = Buffer.from(signedAttrs.bytes);
        signedBytes[0] = 0x31;

        return {
            ldsHash, hashes, digest, messageDigest, eContent: Buffer.from(eContent), signedBytes, signature, sigAlg,
            signerCert: new crypto.X509Certificate(Buffer.from(certs.child(0, 0x30).bytes)),
        };
    } catch (err) {
        if (err instanceof ChipDataError) throw err;
        throw new ChipDataError(`EF.SOD could not be read: ${err.message}`);
    }
}

/** RSASSA-PSS parameters: the hash ([0]) and salt length ([2], default 20). */
function pssParams(params) {
    let digest = 'sha1';
    let saltLength = 20;
    if (params && params.tag === 0x30) {
        const h = params.find(0xa0);
        if (h) digest = DIGESTS[algorithm(h.child(0, 0x30)).oid] || digest;
        const s = params.find(0xa2);
        if (s) saltLength = s.child(0, 0x02).int;
    }
    return {digest, saltLength};
}

/** Checks the signer's signature over the signed attributes. */
function verifySignature(sod) {
    const scheme = SIGNATURES[sod.sigAlg.oid];
    if (!scheme) return {ok: false, problem: 'unsupported_signature_algorithm', algorithm: sod.sigAlg.oid};
    const [kind, fixedDigest] = scheme;
    const key = sod.signerCert.publicKey;
    try {
        let ok;
        if (kind === 'pss') {
            const {digest, saltLength} = pssParams(sod.sigAlg.params);
            ok = crypto.verify(digest, sod.signedBytes, {key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength}, sod.signature);
            return {ok, algorithm: `rsassa-pss-${digest}`};
        }
        const digest = fixedDigest || sod.digest;
        const options = kind === 'ecdsa-plain' ? {key, dsaEncoding: 'ieee-p1363'} : {key};
        ok = crypto.verify(digest, sod.signedBytes, options, sod.signature);
        return {ok, algorithm: `${kind === 'rsa' ? 'rsa' : 'ecdsa'}-${digest}`};
    } catch (err) {
        return {ok: false, problem: 'signature_check_failed', algorithm: sod.sigAlg.oid, error: err.message};
    }
}

// ----- CSCA store -----

const cscaDir = () => process.env.CSCA_DIR || path.join(__dirname, '..', '..', 'config', 'csca');
let store = null;

/** The certificates in a CSCA master list (.ml): CMS signed data holding a SET OF Certificate. */
function masterListCerts(bytes) {
    const root = der.parse(bytes);
    const signedData = root.child(1, 0xa0).child(0, 0x30);
    const encap = signedData.child(2, 0x30);
    if (encap.child(0, 0x06).oid !== OID.cscaMasterList) throw new Error('not a CSCA master list');
    const list = der.parse(encap.child(1, 0xa0).child(0, 0x04).value);
    return list.child(1, 0x31).children.map((c) => Buffer.from(c.bytes));
}

/** Every certificate in a file: a master list, a PEM bundle, or one DER certificate. */
function certsInFile(file) {
    const bytes = fs.readFileSync(file);
    if (file.endsWith('.ml')) return masterListCerts(bytes);
    const text = bytes.toString('latin1');
    if (text.includes('-----BEGIN CERTIFICATE-----')) {
        return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => m[0]);
    }
    return [bytes];
}

/** Loads config/csca/ once: .ml master lists and .pem/.crt/.cer/.der certificates. */
function loadStore({reload = false} = {}) {
    if (store && !reload) return store;
    const certs = [];
    const files = [];
    const dir = cscaDir();
    let names = [];
    try {
        names = fs.readdirSync(dir).filter((n) => /\.(ml|pem|crt|cer|der)$/i.test(n)).sort();
    } catch {
        // No store yet: chips can still be checked for tampering, but not traced to a country.
    }
    const seen = new Set();
    for (const name of names) {
        try {
            let count = 0;
            for (const raw of certsInFile(path.join(dir, name))) {
                const cert = new crypto.X509Certificate(raw);
                if (seen.has(cert.fingerprint256)) continue;
                seen.add(cert.fingerprint256);
                certs.push(cert);
                count++;
            }
            files.push({file: name, certificates: count});
        } catch (err) {
            console.error(`CSCA file ${name} could not be read:`, err.message);
            files.push({file: name, certificates: 0, error: err.message});
        }
    }
    store = {certs, files, loaded_at: new Date().toISOString()};
    return store;
}

/** "C=ZW\nO=..." as {C: 'ZW', O: ...}. */
function nameParts(dn) {
    const out = {};
    for (const line of String(dn || '').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}

/** The CSCA in the store that issued `cert`, checked by signature, or null. */
function findIssuer(cert, certs) {
    for (const ca of certs) {
        if (ca.subject !== cert.issuer) continue;
        try {
            if (cert.checkIssued(ca) && cert.verify(ca.publicKey)) return ca;
        } catch {
            // A key type this Node can't use; try the next one.
        }
    }
    return null;
}

const certSummary = (cert) => cert && {
    subject: cert.subject.replace(/\n/g, ', '),
    country: (nameParts(cert.subject).C || '').toUpperCase() || null,
    serial: cert.serialNumber,
    valid_from: new Date(cert.validFrom).toISOString(),
    valid_to: new Date(cert.validTo).toISOString(),
};

// ----- DG1 and DG2 -----

/** DG1 (tag 61) holds the MRZ as tag 5F1F. Returns the parsed MRZ, as the photo page scan does. */
function parseDg1(bytes) {
    const root = der.parse(bytes);
    if (root.tag !== DG_TAGS[1]) throw new ChipDataError('DG1 has the wrong tag');
    const mrzNode = root.find(0x5f1f);
    if (!mrzNode) throw new ChipDataError('DG1 has no MRZ');
    const text = Buffer.from(mrzNode.value).toString('latin1');
    if (text.length !== 88) throw new ChipDataError(`DG1 holds a ${text.length}-character MRZ, not a passport's 88`);
    return mrzHelper.parse([text.slice(0, 44), text.slice(44)]);
}

/** The face picture inside DG2: a JPEG or a JPEG 2000. Returns {format, data} or null. */
function dg2Photo(bytes) {
    const buf = Buffer.from(bytes);
    const marks = [
        ['jpeg', Buffer.from([0xff, 0xd8, 0xff])],
        ['jp2', Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20])],
        ['j2k', Buffer.from([0xff, 0x4f, 0xff, 0x51])],
    ];
    let best = null;
    for (const [format, mark] of marks) {
        const at = buf.indexOf(mark);
        if (at >= 0 && (!best || at < best.at)) best = {format, at};
    }
    if (!best) return null;
    // The picture runs to the end of the biometric data block (5F2E or 7F2E) that holds it.
    let end = buf.length;
    for (const tag of [Buffer.from([0x5f, 0x2e]), Buffer.from([0x7f, 0x2e])]) {
        const t = buf.lastIndexOf(tag, best.at);
        if (t >= 0) {
            try {
                const node = der.read(buf, t);
                if (node.valueStart <= best.at && node.end > best.at) end = node.end;
            } catch {
                // Not a real tag there; keep the end of the file.
            }
        }
    }
    return {format: best.format === 'j2k' ? 'jp2' : best.format, data: buf.subarray(best.at, end)};
}

// ----- The whole check -----

// The chip only opens with a key made from these, so a chip that opened and disagrees on them is
// another passport's.
const KEY_FIELDS = ['document_number', 'birth_date', 'expiry_date'];
// No check digit covers these on the photo page, so the camera can misread them (a "<" read as "K" after
// a name is common). The chip's signed copy is right; differences are reported, not held against it.
const OTHER_FIELDS = ['surname', 'given_names', 'nationality', 'issuing_country', 'sex'];

/**
 * The scan's details and the chip's, compared. `matches` is about the key fields only; `corrections`
 * lists the other fields where the photo page scan was misread, with what the chip says.
 */
function compareWithScan(chipFields, scanFields) {
    if (!scanFields) return {matches: null, differences: [], corrections: []};
    const differs = (k) => (chipFields[k] || null) !== (scanFields[k] || null);
    const differences = KEY_FIELDS.filter(differs);
    const corrections = OTHER_FIELDS.filter(differs).map((field) => ({field, scan: scanFields[field] || null, chip: chipFields[field] || null}));
    return {matches: differences.length === 0, differences, corrections};
}

/**
 * Checks the files a phone read from a chip. `files` maps com, sod, dg1, dg2, dg14, dg15 to Buffers.
 * Throws ChipDataError when EF.SOD or DG1 can't be read at all; anything else is a result.
 *
 * status: verified (intact, signed, issuer in our store, same as the scan), unverified (intact and
 * signed, but we have no CSCA for that country), or failed (anything didn't hold).
 */
function verify(files, {scanFields = null, now = new Date()} = {}) {
    if (!files.sod) throw new ChipDataError('EF.SOD is missing');
    if (!files.dg1) throw new ChipDataError('DG1 is missing');
    const sod = parseSod(files.sod);
    const problems = [];

    // 1. Every file sent is listed, and hashes to its entry. DG1 must be there.
    const groups = {};
    for (const [name, number] of [['dg1', 1], ['dg2', 2], ['dg14', 14], ['dg15', 15]]) {
        if (!files[name]) continue;
        const expected = sod.hashes[number];
        const ok = Boolean(expected) && hash(sod.ldsHash, files[name]).equals(expected);
        groups[name] = ok;
        if (!expected) problems.push(`${name}_not_in_sod`);
        else if (!ok) problems.push(`${name}_hash_mismatch`);
    }
    const contentIntact = hash(sod.digest, sod.eContent).equals(sod.messageDigest);
    if (!contentIntact) problems.push('sod_digest_mismatch');
    const dataIntact = contentIntact && Object.values(groups).every(Boolean);

    // 2. The signer's signature.
    const sig = verifySignature(sod);
    if (!sig.ok) problems.push(sig.problem || 'signature_invalid');

    // 3. The signer's certificate traced to a CSCA we hold.
    const {certs} = loadStore();
    const signer = certSummary(sod.signerCert);
    const csca = findIssuer(sod.signerCert, certs);
    const haveCountry = certs.some((c) => (nameParts(c.subject).C || '').toUpperCase() === signer.country);
    let issuerTrusted;
    if (csca) issuerTrusted = true;
    else if (haveCountry) {
        issuerTrusted = false;
        problems.push('signer_not_issued_by_csca');
    } else {
        issuerTrusted = null;
        problems.push('no_csca_for_country');
    }
    const signerValidNow = now >= new Date(sod.signerCert.validFrom) && now <= new Date(sod.signerCert.validTo);

    // DG1: what the chip says, against the photo page scan.
    const read = parseDg1(files.dg1);
    const document = read.fields;
    const comparison = compareWithScan(document, scanFields);
    if (comparison.matches === false) problems.push('chip_differs_from_scan');

    const photo = files.dg2 ? dg2Photo(files.dg2) : null;

    let status;
    if (!dataIntact || !sig.ok || issuerTrusted === false || comparison.matches === false) status = 'failed';
    else if (issuerTrusted === null) status = 'unverified';
    else status = 'verified';

    return {
        status,
        verified: status === 'verified',
        checks: {
            data_intact: dataIntact,
            signature_valid: sig.ok,
            issuer_trusted: issuerTrusted,
            matches_scan: comparison.matches,
            signer_certificate_current: signerValidNow,
        },
        problems,
        differences: comparison.differences,
        // Fields the photo page scan misread; use `document` (the chip's) for them.
        scan_corrections: comparison.corrections,
        document,
        data_groups: {...groups, hash_algorithm: sod.ldsHash, listed: Object.keys(sod.hashes).map(Number).sort((a, b) => a - b)},
        signature_algorithm: sig.algorithm || null,
        signer,
        csca: certSummary(csca),
        photo: photo ? {format: photo.format, bytes: photo.data.length} : null,
        // Copy detection (chip or active authentication) isn't done yet.
        clone_check: 'not_done',
        _photo: photo,
    };
}

module.exports = {verify, parseSod, parseDg1, dg2Photo, loadStore, masterListCerts, ChipDataError, OID, DG_TAGS};
