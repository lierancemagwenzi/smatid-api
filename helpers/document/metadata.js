/**
 * What the document says about itself: the software that made it and last saved it, and when. From the
 * Info dictionary and, when there is one, the XMP metadata.
 */

/** "D:20261001083000+02'00'" (or an ISO date, as XMP writes) to a Date, or null. */
function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    const iso = Date.parse(s);
    if (!s.startsWith('D:') && /^\d{4}-\d{2}/.test(s) && Number.isFinite(iso)) return new Date(iso);
    const m = s.replace(/^D:/, '').match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*([Zz+-])?\s*(\d{2})?'?(\d{2})?'?/);
    if (!m) return null;
    const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, oh = '00', om = '00'] = m;
    let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    if (!Number.isFinite(t)) return null;
    if (sign === '+' || sign === '-') t -= (sign === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om)) * 60000;
    return new Date(t);
}

/**
 * Software that changes PDFs after they're made. `kind` sets how much it counts:
 *   editor  online or desktop PDF editors and converters people use to change documents
 *   image   image editors (a document through Photoshop is a picture of a document)
 *   office  word processors: fine for letters, odd for a bank statement or a payslip
 */
const TOOLS = [
    {re: /ilovepdf/i, name: 'iLovePDF', kind: 'editor'},
    {re: /smallpdf/i, name: 'Smallpdf', kind: 'editor'},
    {re: /sejda/i, name: 'Sejda', kind: 'editor'},
    {re: /pdfescape/i, name: 'PDFescape', kind: 'editor'},
    {re: /soda ?pdf/i, name: 'Soda PDF', kind: 'editor'},
    {re: /pdffiller/i, name: 'pdfFiller', kind: 'editor'},
    {re: /dochub/i, name: 'DocHub', kind: 'editor'},
    {re: /pdf ?candy/i, name: 'PDF Candy', kind: 'editor'},
    {re: /pdf2go|pdf24/i, name: 'PDF24 / PDF2Go', kind: 'editor'},
    {re: /foxit (phantom|pdf ?editor|editor)/i, name: 'Foxit PDF Editor', kind: 'editor'},
    {re: /nitro/i, name: 'Nitro PDF', kind: 'editor'},
    {re: /pdf-?xchange (editor|pro)/i, name: 'PDF-XChange Editor', kind: 'editor'},
    {re: /wondershare|pdfelement/i, name: 'Wondershare PDFelement', kind: 'editor'},
    {re: /master ?pdf ?editor/i, name: 'Master PDF Editor', kind: 'editor'},
    {re: /inkscape/i, name: 'Inkscape', kind: 'editor'},
    {re: /canva/i, name: 'Canva', kind: 'editor'},
    {re: /photoshop/i, name: 'Adobe Photoshop', kind: 'image'},
    {re: /\bgimp\b/i, name: 'GIMP', kind: 'image'},
    {re: /paint\.net|mspaint/i, name: 'Paint', kind: 'image'},
    {re: /microsoft.{0,4}word|word for/i, name: 'Microsoft Word', kind: 'office'},
    {re: /libreoffice|openoffice/i, name: 'LibreOffice', kind: 'office'},
    {re: /google docs/i, name: 'Google Docs', kind: 'office'},
    {re: /pages\b|quartz pdfcontext/i, name: 'Apple Pages / macOS print', kind: 'office'},
];

const toolOf = (s) => (s ? TOOLS.find((t) => t.re.test(s)) || null : null);

// Documents that come from a bank's, employer's or utility's system, not from someone typing them.
const ISSUED = ['bank_statement', 'payslip', 'utility_bill'];

function summary(info, xmp, structure) {
    const x = xmp || {};
    return {
        title: info.Title || x['dc:title'] || null,
        author: info.Author || x['dc:creator'] || null,
        creator: info.Creator || x['xmp:creatortool'] || null,
        producer: info.Producer || x['pdf:producer'] || null,
        created: parseDate(info.CreationDate || x['xmp:createdate']),
        modified: parseDate(info.ModDate || x['xmp:modifydate']),
        xmp: xmp ? {
            creator_tool: x['xmp:creatortool'] || null,
            producer: x['pdf:producer'] || null,
            created: parseDate(x['xmp:createdate']),
            modified: parseDate(x['xmp:modifydate']),
        } : null,
        pdf_version: info.PDFFormatVersion || (structure && structure.version) || null,
        producers_over_time: structure ? structure.producers : [],
    };
}

function findings(meta, {docType, now = new Date()} = {}) {
    const out = [];
    const minutes = (a, b) => (b - a) / 60000;
    const tools = [];
    for (const [field, value] of [['producer', meta.producer], ['creator', meta.creator], ...(meta.producers_over_time || []).map((p) => ['earlier producer', p])]) {
        const tool = toolOf(value);
        if (tool && !tools.some((t) => t.tool.name === tool.name)) tools.push({tool, field, value});
    }
    for (const {tool, field, value} of tools) {
        const issued = ISSUED.includes(docType);
        const severity = tool.kind === 'office' ? (issued ? 'warning' : 'info') : 'high';
        out.push({
            category: 'metadata', code: tool.kind === 'image' ? 'image_editor' : tool.kind === 'office' ? 'office_software' : 'pdf_editor', severity,
            title: tool.kind === 'office' ? `Made with ${tool.name}` : `Went through ${tool.name}`,
            detail: tool.kind === 'office'
                ? (issued ? `This kind of document normally comes straight from the issuer's system, not a word processor (${field}: "${value}").` : `${field}: "${value}".`)
                : `${tool.kind === 'image' ? 'An image editor' : 'A PDF editor'} is named in the file's ${field} ("${value}"). Documents issued by banks, employers and utilities aren't made with it.`,
            evidence: {[field.replace(' ', '_')]: value},
        });
    }

    if (meta.created && meta.modified && minutes(meta.created, meta.modified) > 10) {
        const days = Math.round(minutes(meta.created, meta.modified) / 1440);
        out.push({
            category: 'metadata', code: 'modified_after_creation', severity: 'warning',
            title: 'Changed after it was made',
            detail: `Created ${meta.created.toISOString().slice(0, 16).replace('T', ' ')} UTC, last modified ${meta.modified.toISOString().slice(0, 16).replace('T', ' ')} UTC`
                + (days >= 1 ? ` (${days} day${days === 1 ? '' : 's'} later).` : '.'),
            evidence: {created: meta.created, modified: meta.modified},
        });
    }
    if (meta.created && meta.modified && meta.modified < meta.created - 60000) {
        out.push({category: 'metadata', code: 'modified_before_created', severity: 'warning', title: 'Modified before it was created',
            detail: 'The modification date is earlier than the creation date: the dates were set by hand or by a tool.', evidence: {created: meta.created, modified: meta.modified}});
    }
    for (const [label, d] of [['created', meta.created], ['modified', meta.modified]]) {
        if (d && d - now > 24 * 3600 * 1000) {
            out.push({category: 'metadata', code: 'date_in_future', severity: 'high', title: `${label === 'created' ? 'Creation' : 'Modification'} date is in the future`,
                detail: `The file says it was ${label} on ${d.toISOString().slice(0, 10)}.`, evidence: {[label]: d}});
        }
    }
    if (meta.xmp) {
        const differs = (a, b) => a && b && String(a).trim() !== String(b).trim();
        if (differs(meta.xmp.producer, meta.producer) || differs(meta.xmp.creator_tool, meta.creator)) {
            out.push({category: 'metadata', code: 'metadata_disagrees', severity: 'warning', title: 'Its two sets of metadata disagree',
                detail: 'The Info dictionary and the XMP metadata name different software. One was updated by a tool that didn\'t update the other.',
                evidence: {info: {producer: meta.producer, creator: meta.creator}, xmp: {producer: meta.xmp.producer, creator_tool: meta.xmp.creator_tool}}});
        }
        if (meta.xmp.modified && meta.modified && Math.abs(minutes(meta.xmp.modified, meta.modified)) > 10) {
            out.push({category: 'metadata', code: 'metadata_dates_disagree', severity: 'warning', title: 'Its two modification dates disagree',
                detail: 'The Info dictionary and the XMP metadata give different modification dates.', evidence: {info: meta.modified, xmp: meta.xmp.modified}});
        }
    }
    if (!meta.producer && !meta.creator && !meta.created && !meta.modified) {
        out.push({category: 'metadata', code: 'metadata_missing', severity: ISSUED.includes(docType) ? 'warning' : 'info', title: 'No metadata',
            detail: 'The file doesn\'t say what made it or when. Systems that issue documents normally fill these in; they\'re sometimes removed to hide an edit.', evidence: {}});
    }
    return out;
}

module.exports = {parseDate, summary, findings, toolOf, TOOLS};
