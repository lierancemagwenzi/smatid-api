/**
 * Is the person in the passport the person who took the liveness check? Human (the liveness face
 * models) finds the face and its landmarks in each picture; SFace (helpers/passport/faceEmbedHelper.js),
 * a face recognition model, turns each aligned face into a descriptor; and the two are compared.
 *
 * The answer comes in three bands rather than yes/no, because a passport photo can be ten years old,
 * small, and printed or compressed: "review" is for a person to look at.
 */
const faceHelper = require('../liveness/faceHelper');
const embedHelper = require('./faceEmbedHelper');

const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};

/**
 * The bars, as SFace cosine similarity. OpenCV gives 0.363 as SFace's bar for "same person" (on LFW).
 * Measured on 2026-11-06: one person's chip photo and seven liveness checks scored 0.31-0.78 against each
 * other (median 0.62); against eight other people's faces, never above 0.18. A small sample: tune on more.
 */
const thresholds = () => ({
    match: num('FACE_MATCH_MIN_MATCH', 0.4),
    review: num('FACE_MATCH_MIN_REVIEW', 0.25),
    min_face_score: num('FACE_MATCH_MIN_FACE_SCORE', 0.5),
});

class FaceMatchError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

/** The biggest clear face in a JPEG, with its SFace descriptor. Throws FaceMatchError(`code`) if there's none. */
async function describe(jpeg, code) {
    let image;
    let measured;
    try {
        image = faceHelper.decode(jpeg);
        measured = await faceHelper.measure(jpeg);
    } catch (err) {
        if (err.code === 'invalid_frame') throw new FaceMatchError(code);
        throw err;
    }
    const t = thresholds();
    const faces = measured.faces
        .filter((f) => f.landmarks && f.score >= t.min_face_score)
        .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
    if (!faces.length) throw new FaceMatchError(code);
    return {descriptor: await embedHelper.embed(image, faces[0].landmarks), count: faces.length};
}

/**
 * Compares the two pictures. Returns {status, similarity, thresholds, model}; status is match, review
 * or no_match. Throws FaceMatchError no_face_in_passport / no_face_in_liveness.
 */
async function compare(passportJpeg, livenessJpeg) {
    const passport = await describe(passportJpeg, 'no_face_in_passport');
    const live = await describe(livenessJpeg, 'no_face_in_liveness');
    const similarity = Math.round(embedHelper.cosine(passport.descriptor, live.descriptor) * 1000) / 1000;
    const t = thresholds();
    const status = similarity >= t.match ? 'match' : similarity >= t.review ? 'review' : 'no_match';
    return {
        status,
        similarity,
        thresholds: {match: t.match, review: t.review},
        model: embedHelper.MODEL_NAME,
        faces_in_passport_photo: passport.count,
    };
}

module.exports = {compare, describe, thresholds, FaceMatchError};
