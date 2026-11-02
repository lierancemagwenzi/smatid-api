/**
 * Counts attempts per key (usually the caller's IP) in memory, and says when there have been too many.
 * Resets on restart, which is fine for slowing down guessing and email flooding.
 */
module.exports = {
    limiter: function ({max, windowMs}) {
        const hits = new Map();
        const entry = (key) => {
            const e = hits.get(key);
            if (!e || Date.now() - e.since > windowMs) {
                const fresh = {count: 0, since: Date.now()};
                hits.set(key, fresh);
                return fresh;
            }
            return e;
        };
        return {
            blocked: (key) => entry(key).count >= max,
            hit: (key) => {
                entry(key).count++;
            },
            reset: () => hits.clear(),
        };
    },
};
