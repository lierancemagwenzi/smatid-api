/**
 * Builds sample PDFs for the document proofreader: a bank statement, a payslip and a utility bill, each clean
 * or with tampering planted in it. Everyone and everything in them is made up.
 *
 * Used by the tests (test/document.test.js) and by make-samples.js, which writes them out to try in the portal.
 *
 * Tampering (`doctor`, any of):
 *   font        one figure retyped in another font, a hair off its row (what editing a PDF in an editor does)
 *   balance     one figure changed so the sums no longer add up
 *   incremental the file saved again on top of itself by "iLovePDF", later than it was made
 *   cover       a white box drawn over a figure, with another figure written on top
 *   annotation  a white box annotation over a figure
 *   name        (utility bill) the account name given differently further down
 *   nudge       one figure a fraction of a point off its row, in the same font (under the rules' tolerance)
 *   consistent  (bank statement) one amount changed and every balance after it recomputed, so the sums
 *               still add up; drawn with a nudge, as an editor leaves it
 *
 * Clean documents vary too (`variant`): the issuer's software, a harmless re-save a few minutes later.
 */
const {PDFDocument, StandardFonts, rgb, PDFName, PDFString} = require('pdf-lib');

const MADE = new Date('2026-10-01T08:30:00Z');

const money = (n) => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const dmy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

/** A tiny seeded random, so the same options always give the same document. */
function random(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

async function newDoc({title, author, producer, creator, made = MADE, modifiedAfterMinutes = 0}) {
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setAuthor(author);
    doc.setProducer(producer);
    doc.setCreator(creator);
    doc.setCreationDate(made);
    doc.setModificationDate(new Date(made.getTime() + modifiedAfterMinutes * 60000));
    const fonts = {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        other: await doc.embedFont(StandardFonts.TimesRoman),
    };
    return {doc, fonts};
}

/** Writes text with its right edge at x (amount columns are right-aligned). */
function right(page, text, x, y, font, size) {
    page.drawText(text, {x: x - font.widthOfTextAtSize(text, size), y, size, font, color: rgb(0.1, 0.1, 0.1)});
}

/** Plants the `cover` and `font` tampering on one figure: returns the font/offset to draw it with. */
function figureStyle(doctor, fonts, isTarget) {
    if (!isTarget) return {font: fonts.regular, dy: 0};
    if (doctor.includes('font')) return {font: fonts.other, dy: 1.4};
    if (doctor.includes('nudge') || doctor.includes('consistent')) return {font: fonts.regular, dy: 0.3};
    return {font: fonts.regular, dy: 0};
}

/** Draws a white box over a figure and writes another on top: the "cover" trick. */
function cover(page, fonts, x, y, newText, size) {
    page.drawRectangle({x: x - 62, y: y - 2.5, width: 64, height: size + 5, color: rgb(1, 1, 1)});
    right(page, newText, x, y, fonts.regular, size);
}

/** A white "Square" annotation over a figure. */
function whiteAnnotation(doc, page, x, y, w, h) {
    const annot = doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [x, y, x + w, y + h], C: [1, 1, 1], IC: [1, 1, 1],
        F: 4, Contents: PDFString.of(''),
    });
    const ref = doc.context.register(annot);
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

/**
 * Saves the PDF again on top of itself, as an editor's quick save does: a new Info dictionary (with the
 * editor's name and a later date) appended after the original, with its own xref and trailer.
 */
function appendIncrementalUpdate(bytes, {producer = 'iLovePDF', modDate = new Date('2026-10-20T15:12:00Z')} = {}) {
    const text = Buffer.from(bytes).toString('latin1');
    const prevXref = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split(/\s+/)[0]);
    const trailer = text.slice(text.lastIndexOf('trailer'));
    const size = Number(trailer.match(/\/Size (\d+)/)[1]);
    const root = trailer.match(/\/Root (\d+ \d+ R)/)[1];
    const pad = (n, w) => String(n).padStart(w, '0');
    const d = modDate;
    const pdfDate = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}Z`;
    let out = text.endsWith('\n') ? text : `${text}\n`;
    const objOffset = Buffer.byteLength(out, 'latin1');
    out += `${size} 0 obj\n<< /Producer (${producer}) /Creator (${producer}) /ModDate (${pdfDate}) >>\nendobj\n`;
    const xrefOffset = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 1\n0000000000 65535 f \n${size} 1\n${pad(objOffset, 10)} 00000 n \n`;
    out += `trailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prevXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

async function finish(doc, doctor) {
    // A plain xref table (no object streams), as most bank and billing systems write.
    const bytes = Buffer.from(await doc.save({useObjectStreams: false}));
    return doctor.includes('incremental') ? appendIncrementalUpdate(bytes) : bytes;
}

// ----- Bank statement -----

async function bankStatement({doctor = [], seed = 1, rows = 14, producer = 'Harbour Bank Statements 5.2', modifiedAfterMinutes = 0} = {}) {
    const rand = random(seed);
    const {doc, fonts} = await newDoc({
        title: 'Account statement', author: 'Harbour Bank', producer, creator: 'HB Core Banking', modifiedAfterMinutes,
    });
    const page = doc.addPage([595, 842]);
    const t = (s, x, y, o = {}) => page.drawText(s, {x, y, size: o.size || 9, font: o.bold ? fonts.bold : fonts.regular, color: rgb(0.1, 0.1, 0.1)});

    t('HARBOUR BANK', 40, 790, {size: 16, bold: true});
    t('Account statement', 40, 770, {size: 11});
    t('Account holder:', 40, 740); t('TENDAI MOYO', 140, 740);
    t('Account number:', 40, 726); t('4100 2233 9871', 140, 726);
    t('Address:', 40, 712); t('14 MSASA ROAD, HARARE', 140, 712);
    t('Statement period:', 330, 740); t('01/09/2026 - 30/09/2026', 430, 740);
    t('Currency:', 330, 726); t('USD', 430, 726);

    const cols = {date: 40, desc: 100, debit: 380, credit: 460, balance: 550};
    const head = 680;
    t('Date', cols.date, head, {bold: true}); t('Description', cols.desc, head, {bold: true});
    right(page, 'Debit', cols.debit, head, fonts.bold, 9); right(page, 'Credit', cols.credit, head, fonts.bold, 9);
    right(page, 'Balance', cols.balance, head, fonts.bold, 9);

    const opening = 1250.4;
    let balance = opening;
    let y = head - 18;
    t('01/09/2026', cols.date, y); t('Opening balance', cols.desc, y); right(page, money(opening), cols.balance, y, fonts.regular, 9);
    const descriptions = ['POS PURCHASE OK MART', 'SALARY ACME LTD', 'ZESA PREPAID', 'ECOCASH TRANSFER', 'ATM WITHDRAWAL', 'BANK CHARGES', 'TRANSFER FROM T NCUBE'];
    const target = Math.floor(rows / 2);
    let debits = 0;
    let credits = 0;
    for (let i = 0; i < rows; i++) {
        y -= 16;
        const day = 2 + Math.floor((i * 27) / rows);
        const credit = rand() < 0.3;
        let amount = Math.round((credit ? 200 + rand() * 900 : 5 + rand() * 180) * 100) / 100;
        // A careful forgery: the amount changed and the balances after it made to follow.
        if (i === target && doctor.includes('consistent')) amount = Math.round((amount + 100) * 100) / 100;
        balance = Math.round((balance + (credit ? amount : -amount)) * 100) / 100;
        if (credit) credits += amount; else debits += amount;
        t(dmy(new Date(Date.UTC(2026, 8, day))), cols.date, y);
        t(descriptions[Math.floor(rand() * descriptions.length)], cols.desc, y);
        const isTarget = i === target;
        const style = figureStyle(doctor, fonts, isTarget);
        let shown = amount;
        // A changed figure: the row says one amount, the balance moved by another.
        if (isTarget && (doctor.includes('balance') || doctor.includes('font') || doctor.includes('cover'))) shown = Math.round((amount + 100) * 100) / 100;
        if (isTarget && doctor.includes('cover')) {
            right(page, money(amount), credit ? cols.credit : cols.debit, y, fonts.regular, 9);
            cover(page, fonts, credit ? cols.credit : cols.debit, y, money(shown), 9);
        } else {
            right(page, money(shown), credit ? cols.credit : cols.debit, y + style.dy, style.font, 9);
        }
        if (isTarget && doctor.includes('annotation')) whiteAnnotation(doc, page, cols.balance - 60, y - 3, 62, 13);
        right(page, money(balance), cols.balance, y, fonts.regular, 9);
    }
    y -= 24;
    t('Closing balance', cols.desc, y, {bold: true}); right(page, money(balance), cols.balance, y, fonts.bold, 9);
    y -= 14;
    t('Total debits', cols.desc, y); right(page, money(Math.round(debits * 100) / 100), cols.debit, y, fonts.regular, 9);
    t('Total credits', cols.desc, y - 14); right(page, money(Math.round(credits * 100) / 100), cols.credit, y - 14, fonts.regular, 9);
    t('Harbour Bank Ltd is a registered commercial bank. This statement was generated electronically.', 40, 60, {size: 7});
    return finish(doc, doctor);
}

// ----- Payslip -----

async function payslip({doctor = [], seed = 2, producer = 'PayrollPro 9', modifiedAfterMinutes = 0} = {}) {
    const rand = random(seed);
    const {doc, fonts} = await newDoc({title: 'Payslip', author: 'Acme Logistics', producer, creator: 'PayrollPro 9', modifiedAfterMinutes});
    const page = doc.addPage([595, 842]);
    const t = (s, x, y, o = {}) => page.drawText(s, {x, y, size: o.size || 10, font: o.bold ? fonts.bold : fonts.regular, color: rgb(0.1, 0.1, 0.1)});
    t('ACME LOGISTICS (PVT) LTD', 40, 790, {size: 15, bold: true});
    t('Payslip', 40, 770, {size: 11});
    t('Employee:', 40, 740); t('TARIRO GRACE NCUBE', 140, 740);
    t('Employee number:', 40, 726); t('E10442', 140, 726);
    t('Pay period:', 330, 740); t('01/09/2026 - 30/09/2026', 420, 740);
    t('Pay date:', 330, 726); t('25/09/2026', 420, 726);

    const earnings = [['Basic salary', Math.round((900 + rand() * 600) * 100) / 100], ['Housing allowance', 150], ['Transport allowance', 80]];
    const deductions = [['PAYE', Math.round((80 + rand() * 60) * 100) / 100], ['NSSA', 31.5], ['Medical aid', 45]];
    const sum = (rows) => Math.round(rows.reduce((a, [, v]) => a + v, 0) * 100) / 100;
    const gross = sum(earnings);
    const totalDeductions = sum(deductions);
    let net = Math.round((gross - totalDeductions) * 100) / 100;

    let y = 690;
    t('Earnings', 40, y, {bold: true}); right(page, 'Amount', 300, y, fonts.bold, 10);
    for (const [name, v] of earnings) { y -= 16; t(name, 40, y); right(page, money(v), 300, y, fonts.regular, 10); }
    y -= 20; t('Gross pay', 40, y, {bold: true}); right(page, money(gross), 300, y, fonts.bold, 10);
    y -= 30;
    t('Deductions', 40, y, {bold: true});
    for (const [name, v] of deductions) { y -= 16; t(name, 40, y); right(page, money(v), 300, y, fonts.regular, 10); }
    y -= 20; t('Total deductions', 40, y, {bold: true}); right(page, money(totalDeductions), 300, y, fonts.bold, 10);
    y -= 30;
    const target = doctor.includes('balance') || doctor.includes('font') || doctor.includes('cover') || doctor.includes('nudge');
    const shownNet = target && !doctor.includes('nudge') ? Math.round((net + 250) * 100) / 100 : net;
    const style = figureStyle(doctor, fonts, target);
    t('Net pay', 40, y, {bold: true});
    if (doctor.includes('cover')) {
        right(page, money(net), 300, y, fonts.bold, 10);
        cover(page, fonts, 300, y, money(shownNet), 10);
    } else {
        right(page, money(shownNet), 300, y + style.dy, doctor.includes('font') ? style.font : fonts.bold, 10);
    }
    if (doctor.includes('annotation')) whiteAnnotation(doc, page, 238, y - 3, 64, 14);
    y -= 40;
    t('Year to date gross', 40, y); right(page, money(Math.round(gross * 9 * 100) / 100), 300, y, fonts.regular, 10);
    t('This payslip is computer generated.', 40, 60, {size: 7});
    return finish(doc, doctor);
}

// ----- Utility bill -----

async function utilityBill({doctor = [], seed = 3, producer = 'CityBill 3.1', modifiedAfterMinutes = 0} = {}) {
    const rand = random(seed);
    const {doc, fonts} = await newDoc({title: 'Water bill', author: 'City of Harare', producer, creator: 'CityBill 3.1', modifiedAfterMinutes});
    const page = doc.addPage([595, 842]);
    const t = (s, x, y, o = {}) => page.drawText(s, {x, y, size: o.size || 10, font: o.bold ? fonts.bold : fonts.regular, color: rgb(0.1, 0.1, 0.1)});
    t('CITY OF HARARE', 40, 790, {size: 15, bold: true});
    t('Water and refuse account', 40, 770, {size: 11});
    t('Account name:', 40, 740); t('TENDAI MOYO', 150, 740);
    t('Account number:', 40, 726); t('2203-55-1180', 150, 726);
    t('Service address:', 40, 712); t('14 MSASA ROAD, HARARE', 150, 712);
    t('Bill date:', 340, 740); t('05/10/2026', 430, 740);
    t('Billing period:', 340, 726); t('01/09/2026 - 30/09/2026', 430, 726);

    const previous = Math.round((20 + rand() * 60) * 100) / 100;
    const payments = Math.round(previous * 100) / 100;
    const charges = [['Water', Math.round((15 + rand() * 30) * 100) / 100], ['Sewerage', 8.4], ['Refuse', 6.2]];
    const chargeTotal = Math.round(charges.reduce((a, [, v]) => a + v, 0) * 100) / 100;
    const due = Math.round((previous - payments + chargeTotal) * 100) / 100;
    let y = 680;
    t('Previous balance', 40, y); right(page, money(previous), 320, y, fonts.regular, 10);
    y -= 16; t('Payments received', 40, y); right(page, money(-payments), 320, y, fonts.regular, 10);
    for (const [name, v] of charges) { y -= 16; t(name, 40, y); right(page, money(v), 320, y, fonts.regular, 10); }
    y -= 16; t('Total current charges', 40, y, {bold: true}); right(page, money(chargeTotal), 320, y, fonts.bold, 10);
    y -= 24;
    const target = doctor.includes('balance') || doctor.includes('font') || doctor.includes('cover') || doctor.includes('nudge');
    const shown = target && !doctor.includes('nudge') ? Math.round((due - 10) * 100) / 100 : due;
    const style = figureStyle(doctor, fonts, target);
    t('Amount due', 40, y, {bold: true});
    if (doctor.includes('cover')) {
        right(page, money(due), 320, y, fonts.bold, 10);
        cover(page, fonts, 320, y, money(shown), 10);
    } else {
        right(page, money(shown), 320, y + style.dy, doctor.includes('font') ? style.font : fonts.bold, 10);
    }
    if (doctor.includes('annotation')) whiteAnnotation(doc, page, 258, y - 3, 64, 14);
    t(`Account name: ${doctor.includes('name') ? 'TENDAI MOYA' : 'TENDAI MOYO'}`, 40, 100, {size: 8});
    t('Pay at any City of Harare office or through your bank. Please quote your account number.', 40, 60, {size: 7});
    return finish(doc, doctor);
}

const PRODUCERS = {
    bankStatement: ['Harbour Bank Statements 5.2', 'JasperReports Library 6.20', 'iText 7.2.5', 'Crystal Reports'],
    payslip: ['PayrollPro 9', 'Sage Pastel Payroll', 'Belina Payroll 4', 'wkhtmltopdf 0.12.6'],
    utilityBill: ['CityBill 3.1', 'Oracle BI Publisher 12', 'ReportLab PDF Library', 'TCPDF 6.6'],
};
const DOCTORS = {
    bankStatement: ['font', 'balance', 'incremental', 'cover', 'annotation', 'nudge', 'consistent'],
    payslip: ['font', 'balance', 'incremental', 'cover', 'annotation', 'nudge'],
    utilityBill: ['font', 'balance', 'incremental', 'cover', 'annotation', 'nudge', 'name'],
};
const MAKERS = {bankStatement, payslip, utilityBill};

/**
 * A random document for training the tamper classifier: one of the three kinds, clean or doctored (half
 * each), with its figures, length and issuer software varying. Returns {bytes, label, kind, doctor}.
 */
async function variant(seed) {
    const rand = random(seed * 7919 + 13);
    const kinds = Object.keys(MAKERS);
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const doctored = rand() < 0.5;
    let doctor = [];
    if (doctored) {
        const options = DOCTORS[kind];
        doctor = [options[Math.floor(rand() * options.length)]];
        if (rand() < 0.3) doctor.push(options[Math.floor(rand() * options.length)]);
        doctor = [...new Set(doctor)];
    }
    const opts = {
        doctor, seed: seed + 1,
        producer: PRODUCERS[kind][Math.floor(rand() * PRODUCERS[kind].length)],
        // Clean documents are sometimes saved again a few minutes after they're made, harmlessly.
        modifiedAfterMinutes: rand() < 0.3 ? Math.floor(rand() * 8) : 0,
        rows: 8 + Math.floor(rand() * 14),
    };
    return {bytes: await MAKERS[kind](opts), label: doctored ? 'doctored' : 'genuine', kind, doctor};
}

module.exports = {bankStatement, payslip, utilityBill, variant, appendIncrementalUpdate, money};
