/**
 * What the file's own bytes say about its history, without rendering anything:
 *
 * - Incremental updates. A PDF can be changed by appending the changed objects and a new cross-reference
 *   section to the end, leaving the original in place. Editors' quick saves do this. Each one ends in
 *   another "%%EOF". (A linearised "fast web view" file has two by design.)
 * - Digital signatures, and whether anything was appended after the signed byte range.
 * - Scripts, attached files and form fields.
 * - The Producer/Creator written by each save, so a document made by a bank's system and last saved by an
 *   editor shows both.
 */

// Only the uncompressed parts can be read this way; objects inside compressed streams aren't seen.
const latin = (bytes) => Buffer.from(bytes).toString('latin1');

/** Literal PDF strings for a key ("/Producer (iLovePDF)"), in file order. Hex strings are decoded too. */
function stringsFor(text, key) {
    const out = [];
    const re = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`, 'g');
    for (const m of text.matchAll(re)) {
        let v = m[1];
        if (v.startsWith('(')) {
            v = v.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({n: '\n', r: '\r', t: '\t', b: '\b', f: '\f'})[c] || c);
        } else {
            const hex = v.slice(1, -1).replace(/\s+/g, '');
            const buf = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
            v = buf[0] === 0xfe && buf[1] === 0xff ? buf.slice(2).swap16().toString('utf16le') : buf.toString('latin1');
        }
        // UTF-16 with a byte order mark, written as a literal string.
        if (v.charCodeAt(0) === 0xfe && v.charCodeAt(1) === 0xff) v = Buffer.from(v.slice(2), 'latin1').swap16().toString('utf16le');
        v = v.replace(/\0/g, '').trim();
        // Bytes inside a compressed stream can look like "/Producer (…)": only readable text counts.
        const readable = v.replace(/[^\x20-\x7e\u00a0-\u024f]/g, '').length;
        if (!v || readable < v.length * 0.9) continue;
        out.push({value: v, offset: m.index});
    }
    return out;
}

function analyse(bytes) {
    const text = latin(bytes);
    const size = text.length;

    // Where each revision ends. Trailing whitespace after the last one doesn't count as another.
    const eofs = [...text.matchAll(/%%EOF/g)].map((m) => m.index + 5);
    const linearized = /\/Linearized\s/.test(text.slice(0, 2048));
    const revisions = Math.max(1, eofs.length - (linearized && eofs.length > 1 ? 1 : 0));
    const updates = revisions - 1;
    const prevLinks = (text.match(/\/Prev\s+\d+/g) || []).length;

    // Signatures: /ByteRange [0 a b c] covers everything signed. Bytes beyond b + c were added afterwards.
    const signatures = [];
    for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
        const end = Number(m[3]) + Number(m[4]);
        const after = text.slice(end).replace(/[\s\0]+$/, '');
        signatures.push({covers_to: end, modified_after: after.length > 0 && /%%EOF/.test(after)});
    }

    // The tool named by each save, in order. The last one is who saved it last.
    const producers = stringsFor(text, 'Producer').map((p) => p.value).filter(Boolean);
    const creators = stringsFor(text, 'Creator').map((p) => p.value).filter(Boolean);
    const unique = (list) => list.filter((v, i) => list.indexOf(v) === i);

    return {
        size,
        version: (text.slice(0, 16).match(/%PDF-(\d\.\d)/) || [])[1] || null,
        linearized,
        revisions,
        updates,
        prev_links: prevLinks,
        signatures,
        producers: unique(producers),
        creators: unique(creators),
        javascript: /\/(JavaScript|JS)\s*[(<\[/]/.test(text),
        embedded_files: /\/EmbeddedFiles?\b/.test(text),
        forms: /\/AcroForm\b/.test(text),
        object_streams: /\/Type\s*\/ObjStm\b/.test(text),
    };
}

/** Findings from the file's structure. */
function findings(s) {
    const out = [];
    if (s.updates > 0) {
        out.push({
            category: 'structure', code: 'incremental_updates', severity: s.updates > 1 ? 'high' : 'warning',
            title: s.updates === 1 ? 'Saved again after it was made' : `Saved again ${s.updates} times after it was made`,
            detail: 'Changes were appended to the end of the file, on top of the original. That\'s how editors save a changed PDF. '
                + 'Documents straight from a bank or payroll system are normally written once.',
            evidence: {revisions: s.revisions, producers: s.producers},
        });
    }
    if (s.producers.length > 1) {
        out.push({
            category: 'structure', code: 'producer_changed', severity: 'high',
            title: 'Different software wrote different versions',
            detail: `Saved by ${s.producers.map((p) => `"${p}"`).join(', then ')}.`,
            evidence: {producers: s.producers, creators: s.creators},
        });
    }
    for (const sig of s.signatures) {
        if (sig.modified_after) {
            out.push({
                category: 'structure', code: 'changed_after_signing', severity: 'high', title: 'Changed after it was signed',
                detail: 'The file carries a digital signature, but more was added after the signed part.',
                evidence: {signed_to_byte: sig.covers_to, file_size: s.size},
            });
        }
    }
    if (s.signatures.length && !s.signatures.some((x) => x.modified_after)) {
        out.push({
            category: 'structure', code: 'digitally_signed', severity: 'info', title: 'Digitally signed',
            detail: 'Nothing was added after the signature. (The signature itself isn\'t validated against a certificate authority.)',
            evidence: {signatures: s.signatures.length},
        });
    }
    if (s.javascript) {
        out.push({category: 'structure', code: 'javascript', severity: 'warning', title: 'Contains scripts',
            detail: 'Statements, payslips and bills don\'t need scripts. They can change what\'s shown when the file is opened.', evidence: {}});
    }
    if (s.embedded_files) {
        out.push({category: 'structure', code: 'embedded_files', severity: 'warning', title: 'Has files attached inside it',
            detail: 'Other files are attached inside the PDF.', evidence: {}});
    }
    if (s.forms) {
        out.push({category: 'structure', code: 'form_fields', severity: 'info', title: 'Has fillable form fields',
            detail: 'Values in form fields can be typed in by anyone who opens the file.', evidence: {}});
    }
    return out;
}

module.exports = {analyse, findings, stringsFor};
