/**
 * Reads a PDF with pdf.js (Mozilla's, run on the server with nothing fetched and no scripts): its metadata,
 * and for each page the text with where it sits and in which font, the filled shapes and pictures in the
 * order they were drawn, and the annotations.
 *
 * Coordinates are PDF points with the origin at the bottom left, as in the file.
 */
let pdfjsLoaded = null;
const pdfjs = () => (pdfjsLoaded ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

class PdfError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const MAX_PAGES = Number(process.env.DOC_MAX_PAGES) || 50;
const TIMEOUT_MS = Number(process.env.DOC_TIMEOUT_MS) || 30000;

// 2D affine matrices as [a, b, c, d, e, f].
const multiply = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function boxOf(m, x0, y0, x1, y1) {
    const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
}
const rgbOf = (c) => (c && typeof c === 'object' ? [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0] : null);

/**
 * Walks a page's drawing operations and lists what was drawn, in order: where each piece of text started,
 * each filled shape (with its fill colour) and each picture. Annotation appearances are left out (the
 * annotations are read on their own).
 */
function drawing(ops, OPS) {
    const out = {texts: [], fills: [], images: []};
    let ctm = [1, 0, 0, 1, 0, 0];
    let fill = [0, 0, 0];
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let lm = tm;
    let leading = 0;
    let path = null;
    let inAnnotation = 0;
    const moveLine = (tx, ty) => {
        lm = multiply([1, 0, 0, 1, tx, ty], lm);
        tm = lm;
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        switch (fn) {
            case OPS.beginAnnotation: inAnnotation++; break;
            case OPS.endAnnotation: inAnnotation = Math.max(0, inAnnotation - 1); break;
            case OPS.save: stack.push({ctm, fill}); break;
            case OPS.restore: if (stack.length) ({ctm, fill} = stack.pop()); break;
            case OPS.transform: ctm = multiply(args, ctm); break;
            case OPS.setFillRGBColor: fill = rgbOf(args) || fill; break;
            case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; lm = tm; break;
            case OPS.setTextMatrix: tm = args.slice(0, 6); lm = tm; break;
            case OPS.moveText: moveLine(args[0], args[1]); break;
            case OPS.setLeadingMoveText: leading = -args[1]; moveLine(args[0], args[1]); break;
            case OPS.setLeading: leading = args[0]; break;
            case OPS.nextLine: moveLine(0, -leading); break;
            case OPS.nextLineShowText:
            case OPS.nextLineSetSpacingShowText:
                moveLine(0, -leading);
            // falls through
            case OPS.showText:
            case OPS.showSpacedText: {
                if (inAnnotation) break;
                const [x, y] = apply(multiply(tm, ctm), 0, 0);
                out.texts.push({order: i, x, y});
                break;
            }
            case OPS.constructPath: {
                const mm = args && args[2];
                if (mm && mm.length === 4 && Number.isFinite(mm[0])) path = boxOf(ctm, mm[0], mm[1], mm[2], mm[3]);
                break;
            }
            case OPS.fill:
            case OPS.eoFill:
            case OPS.fillStroke:
            case OPS.eoFillStroke:
            case OPS.closeFillStroke:
            case OPS.closeEOFillStroke:
                if (path && !inAnnotation) out.fills.push({order: i, ...path, color: fill});
                path = null;
                break;
            case OPS.endPath:
            case OPS.stroke:
            case OPS.closeStroke:
                path = null;
                break;
            case OPS.paintImageXObject:
            case OPS.paintInlineImageXObject:
            case OPS.paintImageMaskXObject:
                if (!inAnnotation) out.images.push({order: i, ...boxOf(ctm, 0, 0, 1, 1), name: typeof args[0] === 'string' ? args[0] : null});
                break;
            default:
                break;
        }
    }
    return out;
}

/**
 * A picture's pixels as grey, one byte each. pdf.js gives 1-bit grey (packed), RGB or RGBA. Pictures larger
 * than MAX_SIDE on their long side are shrunk (nearest pixel) to keep memory in bounds.
 */
const MAX_SIDE = 2600;
function toGrey(img) {
    const {width, height, data, kind} = img;
    if (!data || !width || !height) return null;
    const step = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
    const w = Math.floor(width / step);
    const h = Math.floor(height / step);
    const out = new Uint8Array(w * h);
    const rowBytes1 = Math.ceil(width / 8);
    for (let y = 0; y < h; y++) {
        const sy = y * step;
        for (let x = 0; x < w; x++) {
            const sx = x * step;
            let v;
            if (kind === 1) v = (data[sy * rowBytes1 + (sx >> 3)] >> (7 - (sx & 7))) & 1 ? 255 : 0;
            else if (kind === 2) {
                const i = (sy * width + sx) * 3;
                v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
            } else {
                const i = (sy * width + sx) * 4;
                v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
            }
            out[y * w + x] = v;
        }
    }
    return {width: w, height: h, grey: out};
}

async function readPage(doc, n, lib) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    const ops = await page.getOperatorList({annotationMode: lib.AnnotationMode.DISABLE});
    const content = await page.getTextContent();
    const fonts = {};
    const items = [];
    for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = it.transform;
        if (!fonts[it.fontName]) {
            let f = null;
            try {
                f = page.commonObjs.get(it.fontName);
            } catch {
                // Not loaded: keep its pdf.js name.
            }
            fonts[it.fontName] = {
                name: (f && f.name) || it.fontName,
                embedded: f ? !f.missingFile : null,
                type: (f && f.type) || null,
            };
        }
        const size = Math.hypot(t[2], t[3]) || it.height || 0;
        items.push({
            text: it.str,
            x: t[4] - x0,
            y: t[5] - y0,
            w: it.width,
            size,
            font: it.fontName,
            rotated: Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3,
        });
    }
    const drawn = drawing(ops, lib.OPS);
    // Pictures covering much of the page (a scan or a photo of the document): their pixels, for the image checks.
    const scans = [];
    for (const im of drawn.images) {
        if (!im.name || im.w * im.h < (x1 - x0) * (y1 - y0) * 0.4) continue;
        let obj = null;
        try {
            obj = page.objs.get(im.name);
        } catch {
            obj = null;
        }
        const grey = obj && toGrey(obj);
        if (grey) scans.push({...grey, x: im.x - x0, y: im.y - y0, w: im.w, h: im.h});
    }
    const annotations = (await page.getAnnotations()).map((a) => ({
        subtype: a.subtype,
        rect: a.rect,
        color: rgbOf(a.color),
        interior: rgbOf(a.interiorColor),
        contents: a.contentsObj ? a.contentsObj.str : a.contents || '',
    }));
    page.cleanup();
    return {
        number: n,
        width: x1 - x0,
        height: y1 - y0,
        items,
        fonts,
        texts: drawn.texts.map((t) => ({...t, x: t.x - x0, y: t.y - y0})),
        fills: drawn.fills.map((f) => ({...f, x: f.x - x0, y: f.y - y0})),
        images: drawn.images.map((im) => ({...im, x: im.x - x0, y: im.y - y0})),
        scans,
        annotations,
    };
}

/**
 * Reads the whole document. Throws PdfError: pdf_encrypted (needs a password), pdf_unreadable,
 * too_many_pages, or pdf_timeout.
 */
async function read(bytes, {maxPages = MAX_PAGES, timeoutMs = TIMEOUT_MS} = {}) {
    const lib = await pdfjs();
    const task = lib.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        disableFontFace: true,
        // No standard font data either: then a font the PDF doesn't carry shows as not embedded, which is
        // what the font checks need to know. Text and widths still come from the PDF itself.
        useSystemFonts: false,
        // Pictures as raw pixels (not browser bitmaps), so they can be examined.
        isOffscreenCanvasSupported: false,
        stopAtErrors: false,
        verbosity: 0,
    });
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PdfError('pdf_timeout', 'Reading the PDF took too long')), timeoutMs);
    });
    try {
        const work = (async () => {
            let doc;
            try {
                doc = await task.promise;
            } catch (err) {
                if (err && err.name === 'PasswordException') throw new PdfError('pdf_encrypted', 'The PDF needs a password');
                throw new PdfError('pdf_unreadable', err && err.message);
            }
            if (doc.numPages > maxPages) throw new PdfError('too_many_pages', `The PDF has ${doc.numPages} pages; the limit is ${maxPages}`);
            const meta = await doc.getMetadata().catch(() => ({info: {}, metadata: null}));
            let xmp = null;
            if (meta.metadata) {
                try {
                    xmp = meta.metadata.getAll();
                } catch {
                    xmp = null;
                }
            }
            const pages = [];
            for (let n = 1; n <= doc.numPages; n++) pages.push(await readPage(doc, n, lib));
            const fonts = {};
            for (const p of pages) {
                for (const [key, f] of Object.entries(p.fonts)) {
                    // pdf.js names fonts per document, so the same key is the same font on every page.
                    if (!fonts[key]) fonts[key] = {...f, items: 0, chars: 0, pages: []};
                }
                for (const it of p.items) {
                    fonts[it.font].items++;
                    fonts[it.font].chars += it.text.trim().length;
                    if (!fonts[it.font].pages.includes(p.number)) fonts[it.font].pages.push(p.number);
                }
            }
            return {numPages: doc.numPages, info: meta.info || {}, xmp, pages, fonts};
        })();
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
        task.destroy().catch(() => {});
    }
}

module.exports = {read, PdfError, MAX_PAGES};
