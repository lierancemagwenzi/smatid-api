const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

// Human (face detection, mesh, anti-spoof and face descriptors) on TensorFlow.js's WebAssembly backend,
// so nothing needs compiling on the server. Its package "exports" don't list the Node builds, hence the paths.
const HUMAN_DIR = path.dirname(path.dirname(require.resolve('@vladmandic/human')));
const WASM_DIR = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')), '/');
const MODELS_DIR = path.join(HUMAN_DIR, 'models');

const MAX_PIXELS = 1600 * 1600;

let ready = null;
// The models run one frame at a time; overlapping calls would just compete for the one CPU.
let queue = Promise.resolve();

/** Node's fetch can't read file:// URLs, which is how Human loads its model files. */
function allowFileFetch() {
    if (globalThis.fetch.allowsFiles) return;
    const realFetch = globalThis.fetch;
    const fileFetch = async (url, options) => {
        const u = String(url && url.url ? url.url : url);
        if (!u.startsWith('file://')) return realFetch(url, options);
        return new Response(await fs.promises.readFile(new URL(u)), {status: 200});
    };
    fileFetch.allowsFiles = true;
    globalThis.fetch = fileFetch;
}

function load() {
    if (!ready) {
        ready = (async () => {
            allowFileFetch();
            const {Human} = require(path.join(HUMAN_DIR, 'dist', 'human.node-wasm.js'));
            const human = new Human({
                backend: 'wasm',
                wasmPath: WASM_DIR,
                modelBasePath: 'file://' + MODELS_DIR + '/',
                debug: false,
                cacheSensitivity: 0,
                face: {
                    enabled: true,
                    detector: {rotation: true, maxDetected: 3, minConfidence: 0.5},
                    mesh: {enabled: true},
                    iris: {enabled: false},
                    description: {enabled: true},
                    emotion: {enabled: false},
                    antispoof: {enabled: true},
                    liveness: {enabled: true},
                },
                body: {enabled: false},
                hand: {enabled: false},
                object: {enabled: false},
                gesture: {enabled: false},
                segmentation: {enabled: false},
                filter: {enabled: false},
            });
            await human.load();
            await human.warmup();
            return human;
        })().catch((err) => {
            ready = null;
            throw err;
        });
    }
    return ready;
}

/**
 * Where the nose sits between the two cheeks, from 0 to 1, in the frame as the camera took it (not
 * mirrored). About 0.5 when facing the camera. Turning to your own left moves the nose towards the
 * right of the picture, so the value goes up; turning right brings it down.
 */
function turnOf(mesh) {
    const [left, right] = [mesh[234][0], mesh[454][0]].sort((a, b) => a - b);
    return right > left ? (mesh[1][0] - left) / (right - left) : 0.5;
}

/** The gap between the lips, as a share of the face's height (forehead to chin). */
function mouthOf(mesh) {
    const gap = Math.hypot(mesh[13][0] - mesh[14][0], mesh[13][1] - mesh[14][1]);
    const height = Math.hypot(mesh[10][0] - mesh[152][0], mesh[10][1] - mesh[152][1]);
    return height > 0 ? gap / height : 0;
}

module.exports = {
    load,
    turnOf,
    mouthOf,

    /** Throws a coded error for anything that isn't a JPEG of a sensible size. */
    decode: function (buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
            throw Object.assign(new Error('not a JPEG'), {code: 'invalid_frame'});
        }
        try {
            return jpeg.decode(buffer, {useTArray: true, formatAsRGBA: false, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 64});
        } catch {
            throw Object.assign(new Error('unreadable JPEG'), {code: 'invalid_frame'});
        }
    },

    /** Every face in a JPEG frame, with what the liveness rules need. */
    measure: function (buffer) {
        const image = this.decode(buffer);
        const run = queue.then(async () => {
            const human = await load();
            const input = human.tf.tensor4d(image.data, [1, image.height, image.width, 3], 'int32');
            try {
                const result = await human.detect(input);
                return {
                    width: image.width,
                    height: image.height,
                    faces: result.face.map((f) => ({
                        score: f.score,
                        box: f.box,
                        width_share: f.box[2] / image.width,
                        turn: f.mesh && f.mesh.length > 454 ? turnOf(f.mesh) : null,
                        mouth: f.mesh && f.mesh.length > 152 ? mouthOf(f.mesh) : null,
                        real: f.real,
                        live: f.live,
                        embedding: f.embedding ? Array.from(f.embedding) : null,
                    })),
                };
            } finally {
                human.tf.dispose(input);
            }
        });
        queue = run.catch(() => {});
        return run;
    },

    /** How alike two faces are, from 0 to 1. */
    similarity: async function (a, b) {
        const human = await load();
        return human.match.similarity(a, b);
    },
};
