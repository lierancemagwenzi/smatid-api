/**
 * Scanned sample PDFs: a page picture (from tools/docforensics/forge.py --samples) filling an A4 page, with no
 * text layer, as a scanner or a phone app makes them.
 */
const fs = require('fs');
const path = require('path');
const {PDFDocument} = require('pdf-lib');

const DIR = path.join(__dirname, '..', '..', 'storage', 'doccheck-samples', 'scans');

async function scannedPdf(jpegPath, {producer = 'Canon iR-ADV C5535 PDF', made = new Date('2026-10-02T09:15:00Z')} = {}) {
    const doc = await PDFDocument.create();
    doc.setProducer(producer);
    doc.setCreator(producer);
    doc.setCreationDate(made);
    doc.setModificationDate(made);
    const img = await doc.embedJpg(fs.readFileSync(jpegPath));
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(img, {x: 0, y: 0, width: 595.28, height: 841.89});
    return Buffer.from(await doc.save({useObjectStreams: false}));
}

module.exports = {scannedPdf, DIR};
