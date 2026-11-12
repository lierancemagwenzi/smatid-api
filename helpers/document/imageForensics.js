/**
 * Scanned pages: pictures of a document, with no text to check. Two ways of finding where the picture was
 * changed:
 *
 * - The forgery model (tools/docforensics): a small network trained to mark changed pixels, run with
 *   onnxruntime from config/doc-models/forensics.onnx (or DOC_MODEL_DIR). Optional: without it, only the
 *   second check runs, and the report says so.
 * - Error level analysis: the page is saved as a JPEG once more, and each area's change measured. Areas that
 *   were edited after the scan was saved can respond differently from the rest. On generated scans it flagged
 *   large bold headings on clean pages and missed retyped figures, so it isn't reported as a finding: its
 *   count of standout areas is only one of the tamper classifier's measurements.
 *
 * Pages are first scaled to about 150 dpi, which is what the model was trained at.
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const modelDir = () => process.env.DOC_MODEL_DIR || path.join(__dirname, '..', '..', 'config', 'doc-models');
const TARGET_DPI = 150;
const CELL = 8;

// ----- Pixels -----

/** Bilinear resize of a grey picture. */
function resize(src, w, h, W, H) {
    if (w === W && h === H) return src;
    const out = new Uint8Array(W * H);
    const sx = w / W;
    const sy = h / H;
    for (let y = 0; y < H; y++) {
        const fy = Math.min(h - 1, (y + 0.5) * sy - 0.5);
        const y0 = Math.max(0, Math.floor(fy));
        const y1 = Math.min(h - 1, y0 + 1);
        const ty = fy - y0;
        for (let x = 0; x < W; x++) {
            const fx = Math.min(w - 1, (x + 0.5) * sx - 0.5);
            const x0 = Math.max(0, Math.floor(fx));
            const x1 = Math.min(w - 1, x0 + 1);
            const tx = fx - x0;
            const a = src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx;
            const b = src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx;
            out[y * W + x] = a * (1 - ty) + b * ty;
        }
    }
    return out;
}

/** A scan scaled to ~150 dpi, from its size on the page (points are 1/72 inch). */
function normalise(scan) {
    const W = Math.max(64, Math.round((scan.w / 72) * TARGET_DPI));
    const H = Math.max(64, Math.round((scan.h / 72) * TARGET_DPI));
    // Don't blow small pictures up more than twice.
    const scale = Math.min(W / scan.width, 2);
    const w = Math.round(scan.width * scale);
    const h = Math.round(scan.height * scale);
    return {grey: resize(scan.grey, scan.width, scan.height, w, h), width: w, height: h};
}

/** Connected groups of flagged cells (4-neighbour), as cell boxes with their peak value. */
function regions(cells, cw, ch, minCells) {
    const seen = new Uint8Array(cw * ch);
    const out = [];
    for (let i = 0; i < cw * ch; i++) {
        if (!cells[i] || seen[i]) continue;
        const stack = [i];
        seen[i] = 1;
        let x0 = cw;
        let y0 = ch;
        let x1 = 0;
        let y1 = 0;
        let n = 0;
        let peak = 0;
        while (stack.length) {
            const j = stack.pop();
            const x = j % cw;
            const y = (j - x) / cw;
            n++;
            peak = Math.max(peak, cells[j]);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            for (const k of [j - 1, j + 1, j - cw, j + cw]) {
                if (k < 0 || k >= cw * ch || seen[k] || !cells[k]) continue;
                if ((k === j - 1 && x === 0) || (k === j + 1 && x === cw - 1)) continue;
                seen[k] = 1;
                stack.push(k);
            }
        }
        if (n >= minCells) out.push({x0, y0, x1: x1 + 1, y1: y1 + 1, cells: n, peak});
    }
    return out;
}

/** A box in picture pixels as fractions of the PDF page, top-left origin. */
function pageBox(page, scan, img, {x0, y0, x1, y1}) {
    const fx = scan.w / img.width;
    const fy = scan.h / img.height;
    const left = scan.x + x0 * fx;
    const top = scan.y + scan.h - y0 * fy; // picture rows run downwards; PDF y upwards
    const r = (v) => Math.round(v * 10000) / 10000;
    return [r(left / page.width), r(1 - top / page.height), r(((x1 - x0) * fx) / page.width), r(((y1 - y0) * fy) / page.height)];
}

// ----- Error level analysis -----

function ela(img) {
    const {grey, width, height} = img;
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < grey.length; i++) {
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = grey[i];
        rgba[i * 4 + 3] = 255;
    }
    const again = jpeg.decode(jpeg.encode({data: rgba, width, height}, 90).data, {useTArray: true, formatAsRGBA: true});
    const cw = Math.floor(width / 16);
    const ch = Math.floor(height / 16);
    const err = new Float32Array(cw * ch);
    const detail = new Float32Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            let e = 0;
            let g = 0;
            for (let y = cy * 16; y < cy * 16 + 16; y++) {
                for (let x = cx * 16; x < cx * 16 + 16; x++) {
                    const i = y * width + x;
                    e += Math.abs(grey[i] - again.data[i * 4]);
                    if (x + 1 < width) g += Math.abs(grey[i] - grey[i + 1]);
                }
            }
            err[cy * cw + cx] = e / 256;
            detail[cy * cw + cx] = g / 256;
        }
    }
    // How much each area changed, for how much detail it has: edited areas stand out from areas like them.
    const ratios = [];
    for (let i = 0; i < err.length; i++) if (detail[i] > 2) ratios.push(err[i] / (detail[i] + 1));
    if (ratios.length < 20) return {outliers: 0, regions: []};
    const sorted = [...ratios].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const mad = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 1e-6;
    const cells = new Float32Array(cw * ch);
    let outliers = 0;
    for (let i = 0; i < err.length; i++) {
        if (detail[i] <= 2) continue;
        const z = (err[i] / (detail[i] + 1) - med) / (1.4826 * mad);
        if (z > 6) {
            cells[i] = z;
            outliers++;
        }
    }
    return {outliers, regions: regions(cells, cw, ch, 3).map((r) => ({...r, scale: 16}))};
}

// ----- The forgery model -----

let session;
let meta;
async function model() {
    if (session !== undefined) return session;
    session = null;
    const file = path.join(modelDir(), 'forensics.onnx');
    if (!fs.existsSync(file)) return null;
    try {
        const ort = require('onnxruntime-node');
        session = await ort.InferenceSession.create(file);
        meta = JSON.parse(fs.readFileSync(path.join(modelDir(), 'forensics.json'), 'utf8'));
    } catch (err) {
        console.error('Could not load the image forgery model:', err.message);
        session = null;
    }
    return session;
}

function reload() {
    session = undefined;
    meta = undefined;
}

async function runModel(img) {
    const s = await model();
    if (!s) return null;
    const ort = require('onnxruntime-node');
    const H = Math.ceil(img.height / 16) * 16;
    const W = Math.ceil(img.width / 16) * 16;
    const input = new Float32Array(W * H).fill(0.95);
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) input[y * W + x] = img.grey[y * img.width + x] / 255;
    }
    const out = await s.run({[meta.input.name]: new ort.Tensor('float32', input, [1, 1, H, W])});
    const prob = out[meta.output.name].data;
    // Pooled over 8x8 cells, as the page threshold was set.
    const cw = Math.floor(img.width / CELL);
    const ch = Math.floor(img.height / CELL);
    const cells = new Float32Array(cw * ch);
    let max = 0;
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            let sum = 0;
            for (let y = cy * CELL; y < cy * CELL + CELL; y++) for (let x = cx * CELL; x < cx * CELL + CELL; x++) sum += prob[y * W + x];
            const v = sum / (CELL * CELL);
            cells[cy * cw + cx] = v;
            if (v > max) max = v;
        }
    }
    const flagged = cells.map((v) => (v >= meta.pixel_threshold ? v : 0));
    return {
        max,
        threshold: meta.page_threshold,
        regions: regions(flagged, cw, ch, 2).filter((r) => r.peak >= meta.page_threshold).map((r) => ({...r, scale: CELL})),
        version: meta.version,
    };
}

/**
 * Examines every scanned page. Returns {findings, max_score, regions, ela_outliers, model: {used, version}}.
 */
async function analyse(doc) {
    const findings = [];
    let maxScore = 0;
    let regionCount = 0;
    let elaOutliers = 0;
    let used = false;
    let version = null;
    for (const page of doc.pages) {
        for (const scan of page.scans || []) {
            const img = normalise(scan);
            const m = await runModel(img);
            if (m) {
                used = true;
                version = m.version;
                maxScore = Math.max(maxScore, m.max);
                for (const r of m.regions.slice(0, 6)) {
                    regionCount++;
                    const pct = Math.round(r.peak * 100);
                    findings.push({
                        // "Look at", not "serious": tested only on generated scans (forensics.json has its scores),
                        // where about 1 clean page in 30 was flagged. Raise it once real forged scans back it up.
                        category: 'image', code: 'image_edited_region', severity: 'warning',
                        title: `Part of the scan looks edited (${pct}%)`,
                        detail: 'The forgery model marks this area of the picture as changed after it was scanned: retyped, pasted in, smudged or moved.',
                        page: page.number, box: pageBox(page, scan, img, {x0: r.x0 * r.scale, y0: r.y0 * r.scale, x1: r.x1 * r.scale, y1: r.y1 * r.scale}),
                        evidence: {probability: Math.round(r.peak * 1000) / 1000, model_version: m.version},
                    });
                }
            }
            elaOutliers += ela(img).outliers;
        }
    }
    if (!used && doc.pages.some((p) => p.scans && p.scans.length)) {
        findings.push({category: 'image', code: 'image_model_unavailable', severity: 'info', title: 'The scanned pages couldn\'t be examined for edits',
            detail: 'The image forgery model isn\'t installed on this server, so only the file\'s history and metadata were checked.', page: null, box: null, evidence: {}});
    }
    return {findings, max_score: Math.round(maxScore * 1000) / 1000, regions: regionCount, ela_outliers: elaOutliers, model: {used, version}};
}

module.exports = {analyse, reload, resize, regions, ela};
