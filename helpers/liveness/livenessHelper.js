const crypto = require('crypto');

const CHALLENGES = ['turn_left', 'turn_right', 'open_mouth'];

const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
};

module.exports = {
    STEPS: ['center', ...CHALLENGES],

    /**
     * The limits a frame must meet. The hosted page gets the same numbers, so it only takes a frame the
     * server will accept. They're starting points: tune them with real people and phones.
     */
    thresholds: () => ({
        // Nose position (see faceHelper.turnOf): looking straight means within this of 0.5,
        center_max_offset: num('LIVENESS_CENTER_MAX_OFFSET', 0.1),
        // and a turn means at least this far from 0.5, on the asked-for side.
        turn_min_offset: num('LIVENESS_TURN_MIN_OFFSET', 0.15),
        // Gap between the lips as a share of face height, and how much wider than in the straight-on frame.
        mouth_min_open: num('LIVENESS_MOUTH_MIN_OPEN', 0.1),
        mouth_min_gain: num('LIVENESS_MOUTH_MIN_GAIN', 0.06),
        // How much of the frame's width the face must fill: close enough to see clearly.
        face_min_width_share: num('LIVENESS_FACE_MIN_WIDTH_SHARE', 0.2),
        min_face_score: num('LIVENESS_MIN_FACE_SCORE', 0.6),
        // Human's anti-spoof model (0 = a photo or screen, 1 = a real face), averaged over the frames.
        min_real: num('LIVENESS_MIN_REAL', 0.5),
        // Face descriptors: every frame must be the same person as the straight-on one. On a webcam the
        // same person scored 0.42-0.92 (two face-on frames as low as 0.47), and lower with the head turned
        // or the mouth open, so this only catches an obvious swap of faces between frames.
        min_similarity: num('LIVENESS_MIN_SIMILARITY', 0.4),
        min_similarity_turned: num('LIVENESS_MIN_SIMILARITY_TURNED', 0.35),
    }),

    /** "center" first, then the three challenges in a random order, so a recording made beforehand won't fit. */
    newSteps: function () {
        const rest = [...CHALLENGES];
        for (let i = rest.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        return ['center', ...rest];
    },

    /** Why one face fails a step, or null when it's fine. `center` is the straight-on face, for the mouth step. */
    stepProblem: function (step, face, center, t) {
        const offset = face.turn - 0.5;
        if (step === 'center' && Math.abs(offset) > t.center_max_offset) return 'not_facing_camera';
        if (step === 'turn_left' && offset < t.turn_min_offset) return 'did_not_turn_left';
        if (step === 'turn_right' && offset > -t.turn_min_offset) return 'did_not_turn_right';
        if (step === 'open_mouth' && (face.mouth < t.mouth_min_open || (center && face.mouth - center.mouth < t.mouth_min_gain))) {
            return 'mouth_not_open';
        }
        return null;
    },

    /**
     * The server's verdict. `measurements` are faceHelper.measure results, one per step in order;
     * `hashes` are the frames' SHA-256s. `similarity(a, b)` compares two face descriptors.
     */
    verify: async function (steps, measurements, hashes, similarity) {
        const t = this.thresholds();
        const report = [];
        let failure = null;
        const fail = (reason) => (failure = failure || reason);

        if (measurements.length !== steps.length) fail('wrong_frame_count');
        if (new Set(hashes).size !== hashes.length) fail('duplicate_frames');

        const faces = measurements.map((m) => (m.faces.length === 1 ? m.faces[0] : null));
        const center = faces[0];

        for (let i = 0; i < steps.length; i++) {
            const m = measurements[i] || {faces: []};
            const face = faces[i];
            let problem = null;
            if (!m.faces.length) problem = 'no_face';
            else if (m.faces.length > 1) problem = 'multiple_faces';
            else if (face.score < t.min_face_score) problem = 'no_face';
            else if (face.width_share < t.face_min_width_share) problem = 'face_too_small';
            else if (face.turn === null || face.mouth === null) problem = 'no_face';
            else problem = this.stepProblem(steps[i], face, i > 0 ? center : null, t);

            let same = null;
            if (!problem && i > 0 && center && center.embedding && face.embedding) {
                same = await similarity(center.embedding, face.embedding);
                const bar = steps[i].startsWith('turn_') ? t.min_similarity_turned : t.min_similarity;
                if (same < bar) problem = 'different_person';
            }
            if (problem) fail(problem);
            report.push({
                step: steps[i],
                ok: !problem,
                problem,
                turn: face ? round(face.turn) : null,
                mouth: face ? round(face.mouth) : null,
                real: face ? round(face.real) : null,
                similarity: same === null ? null : round(same),
            });
        }

        const reals = faces.filter(Boolean).map((f) => f.real).filter((r) => typeof r === 'number');
        const realAverage = reals.length ? reals.reduce((a, b) => a + b, 0) / reals.length : 0;
        if (!failure && realAverage < t.min_real) fail('spoof_suspected');

        const sims = report.map((r) => r.similarity).filter((s) => s !== null);
        return {
            passed: !failure,
            failure_reason: failure,
            scores: {
                real: round(realAverage),
                similarity: sims.length ? round(Math.min(...sims)) : null,
            },
            steps: report,
            thresholds: t,
        };
    },
};

function round(v) {
    return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
}
