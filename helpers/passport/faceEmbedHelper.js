/**
 * Face descriptors for comparing a passport photo with a live face, using SFace (OpenCV model zoo,
 * Apache 2.0): a face recognition model trained for this, unlike the one liveness uses to compare its
 * own frames. The face is first aligned the way SFace expects (as OpenCV's FaceRecognizerSF does):
 * five landmarks mapped onto a fixed 112x112 template by a similarity transform.
 *
 * Human (helpers/liveness/faceHelper.js) still finds the face and its landmarks.
 */
const path = require('path');

const MODEL = () => process.env.FACE_MODEL_PATH || path.join(__dirname, '..', '..', 'vendor', 'face', 'face_recognition_sface_2021dec.onnx');
const SIZE = 112;

// Where SFace (like ArcFace) wants the person's right eye, left eye, nose tip, right and left mouth
// corners to be in the 112x112 crop. The person's right is the picture's left.
const TEMPLATE = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

// The same five points on Human's 468-point face mesh (MediaPipe FaceMesh numbering): eye corners
// averaged into eye centres, the nose tip, and the mouth corners.
const MESH_POINTS = [[33, 133], [362, 263], [1], [61], [291]];

/** The five landmarks from a face mesh, or null if the mesh is too short. */
function landmarksFromMesh(mesh) {
    if (!Array.isArray(mesh) || mesh.length < 468) return null;
    return MESH_POINTS.map((idx) => {
        const pts = idx.map((i) => mesh[i]);
        return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    });
}

/**
 * The similarity transform (scale, rotation, shift) that best maps `src` points onto `dst`
 * (Umeyama's least-squares method, in 2D). Returns [a, b, tx, ty] for x' = a·x − b·y + tx, y' = b·x + a·y + ty.
 */
function similarityTransform(src, dst) {
    const n = src.length;
    const mean = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n;
    const sx = mean(src, 0), sy = mean(src, 1), dx = mean(dst, 0), dy = mean(dst, 1);
    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const ux = src[i][0] - sx, uy = src[i][1] - sy;
        const vx = dst[i][0] - dx, vy = dst[i][1] - dy;
        num1 += ux * vx + uy * vy;
        num2 += ux * vy - uy * vx;
        den += ux * ux + uy * uy;
    }
    if (!den) throw new Error('landmarks are all in one place');
    const a = num1 / den;
    const b = num2 / den;
    return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

/**
 * The aligned 112x112 face as SFace's input: RGB, 0-255, channels first. `image` is {data, width,
 * height} with 3 bytes (RGB) per pixel. Bilinear sampling; outside the picture is black.
 */
function alignedInput(image, landmarks) {
    const [a, b, tx, ty] = similarityTransform(landmarks, TEMPLATE);
    // Invert the transform, so each output pixel knows where in the picture it comes from.
    const det = a * a + b * b;
    const ia = a / det, ib = -b / det;
    const out = new Float32Array(3 * SIZE * SIZE);
    const {data, width, height} = image;
    const px = (x, y, c) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + c]);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const ux = x - tx, uy = y - ty;
            const sx = ia * ux - ib * uy;
            const sy = ib * ux + ia * uy;
            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const fx = sx - x0, fy = sy - y0;
            for (let c = 0; c < 3; c++) {
                const v = px(x0, y0, c) * (1 - fx) * (1 - fy) + px(x0 + 1, y0, c) * fx * (1 - fy)
                    + px(x0, y0 + 1, c) * (1 - fx) * fy + px(x0 + 1, y0 + 1, c) * fx * fy;
                out[c * SIZE * SIZE + y * SIZE + x] = v;
            }
        }
    }
    return out;
}

let session = null;

async function model() {
    if (!session) {
        const ort = require('onnxruntime-node');
        session = ort.InferenceSession.create(MODEL(), {logSeverityLevel: 3}).then((s) => ({ort, s}));
        session.catch(() => (session = null));
    }
    return session;
}

/** The SFace descriptor of the face at `landmarks` in `image`: 128 numbers, scaled to length 1. */
async function embed(image, landmarks) {
    const {ort, s} = await model();
    const input = new ort.Tensor('float32', alignedInput(image, landmarks), [1, 3, SIZE, SIZE]);
    const result = await s.run({[s.inputNames[0]]: input});
    const v = Array.from(result[s.outputNames[0]].data);
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}

/** Cosine similarity of two descriptors from embed(): 1 is identical; SFace's own bar for "same person" is 0.363. */
const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

module.exports = {embed, cosine, landmarksFromMesh, similarityTransform, alignedInput, TEMPLATE, MODEL_NAME: 'sface-2021dec'};
