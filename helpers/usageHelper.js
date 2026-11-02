/** Turns logged KYC calls into what the admin pages show. */
module.exports = {
    /** What was searched for, in a few words: the company number, or the person or company name. */
    subject: function (row) {
        const request = row.request || {};
        if (row.check_type === 'company') return (request.params && request.params.number) || null;
        if (row.check_type === 'liveness') {
            const response = row.response || {};
            return (request.body && request.body.reference) || response.reference || (request.params && request.params.sessionId) || response.session_id || null;
        }
        const body = request.body || {};
        if (body.name) return String(body.name);
        const parts = [body.first_name, body.middle_name, body.last_name].filter(Boolean);
        return parts.length ? parts.join(' ') : null;
    },

    /** outcome is one of found, not_found, clear, hit, sanctioned, pep, passed, failed, pending, expired, error. */
    result: function (row) {
        const r = row.response || {};
        if (row.status >= 400 && !(row.check_type === 'company' && row.status === 404)) {
            return {outcome: 'error', label: r.error || `HTTP ${row.status}`};
        }
        if (row.check_type === 'company') {
            if (row.status === 404 || r.found === false) return {outcome: 'not_found', label: 'Not on the register'};
            return {outcome: 'found', label: [r.name, r.status].filter(Boolean).join(' · ')};
        }
        if (row.check_type === 'liveness') {
            const status = r.status;
            if (status === 'passed') return {outcome: 'passed', label: 'Live person confirmed'};
            if (status === 'failed') return {outcome: 'failed', label: `Failed: ${r.failure_reason || 'no attempts left'}`};
            if (status === 'expired') return {outcome: 'expired', label: 'Link expired'};
            if (row.status === 201) return {outcome: 'pending', label: 'Session opened'};
            return {outcome: 'pending', label: r.attempts ? `In progress (${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'} so far)` : 'Not taken yet'};
        }
        if (row.check_type === 'sanctions') {
            if (!r.hit) return {outcome: 'clear', label: 'No match'};
            const top = r.matches && r.matches[0];
            const name = top ? `${top.name} (${Math.round(top.score * 100)}%)` : '';
            if (r.sanctioned) return {outcome: 'sanctioned', label: `Sanctioned: ${name}`};
            if (r.pep) return {outcome: 'pep', label: `PEP: ${name}`};
            return {outcome: 'hit', label: `Match: ${name}`};
        }
        return {outcome: 'found', label: `HTTP ${row.status}`};
    },

    /** One row of the usage list: no full response, which can be large. */
    listItem: function (row) {
        return {
            id: row.id,
            client_id: row.client_id,
            client_name: row.client ? row.client.name : null,
            check_type: row.check_type,
            subject: this.subject(row),
            status: row.status,
            ...this.result(row),
            duration_ms: row.duration_ms,
            created_at: row.createdAt,
        };
    },

    detail: function (row) {
        const response = row.response || {};
        return {
            ...this.listItem(row),
            // Liveness rows link to their session, whose frames the admin can look at.
            liveness_session_id: row.check_type === 'liveness' ? response.session_id || null : null,
            method: row.method,
            path: row.path,
            ip: row.ip,
            request: row.request,
            response: row.response,
        };
    },
};
