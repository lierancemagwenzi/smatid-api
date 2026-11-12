/**
 * Multinomial logistic regression, in plain JavaScript: small, fast to train on a few thousand rows, and
 * easy to save as JSON. Shared by the ID card field tagger (helpers/idcard/model.js) and the document
 * tamper classifier (helpers/document/model.js).
 *
 * Rows are number[] with a 1 in column 0 for the bias.
 */

function standardise(X) {
    const n = X.length;
    const d = X[0].length;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
    for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
    // The bias column stays 1.
    mean[0] = 0;
    std[0] = 1;
    return {mean, std};
}

const scale = (x, {mean, std}) => x.map((v, j) => (v - mean[j]) / std[j]);

function softmax(z) {
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
}

/** Trains on rows X (number[][]) with labels y (class names). Full-batch gradient descent with L2. */
function trainSoftmax(X, y, classes, {epochs = 400, rate = 0.5, l2 = 1e-3} = {}) {
    const norm = standardise(X);
    const Xs = X.map((x) => scale(x, norm));
    const d = Xs[0].length;
    const k = classes.length;
    const W = Array.from({length: k}, () => new Array(d).fill(0));
    const target = y.map((c) => classes.indexOf(c));
    // Rare classes (a field is one line among many) count for as much as common ones.
    const counts = new Array(k).fill(0);
    for (const t of target) counts[t]++;
    const weight = counts.map((c) => (c ? Xs.length / (k * c) : 0));

    for (let epoch = 0; epoch < epochs; epoch++) {
        const grad = Array.from({length: k}, () => new Array(d).fill(0));
        let total = 0;
        for (let i = 0; i < Xs.length; i++) {
            const x = Xs[i];
            const p = softmax(W.map((w) => w.reduce((s, wj, j) => s + wj * x[j], 0)));
            const wi = weight[target[i]];
            total += wi;
            for (let c = 0; c < k; c++) {
                const g = (p[c] - (c === target[i] ? 1 : 0)) * wi;
                if (g) for (let j = 0; j < d; j++) grad[c][j] += g * x[j];
            }
        }
        for (let c = 0; c < k; c++) {
            for (let j = 0; j < d; j++) W[c][j] -= rate * (grad[c][j] / total + (j ? l2 * W[c][j] : 0));
        }
    }
    return {classes, mean: norm.mean, std: norm.std, W};
}

/** Class probabilities for one row, by class name. */
function predict(m, x) {
    const xs = scale(x, m);
    const p = softmax(m.W.map((w) => w.reduce((s, wj, j) => s + wj * xs[j], 0)));
    return Object.fromEntries(m.classes.map((c, i) => [c, p[i]]));
}

/** A repeatable shuffle, so the same labelled scans always split the same way. */
function shuffled(items, seed = 42) {
    const out = [...items];
    let s = seed;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

module.exports = {trainSoftmax, predict, shuffled, softmax, standardise, scale};
