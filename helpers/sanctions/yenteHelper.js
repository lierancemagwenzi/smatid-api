const axios = require('axios');

const SCHEMAS = {person: 'Person', company: 'Company'};
const DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function baseUrl() {
    return (process.env.YENTE_URL || 'http://localhost:8000').replace(/\/+$/, '');
}

function clean(value) {
    if (value === undefined || value === null) return [];
    return (Array.isArray(value) ? value : [value])
        .map((v) => String(v).trim())
        .filter(Boolean);
}

function hasTopic(topics, prefix) {
    return topics.some((t) => t === prefix || t.startsWith(`${prefix}.`));
}

module.exports = {
    /**
     * Turns our request body into a yente query-by-example entity.
     * Returns {error} when the body can't be screened.
     */
    buildQuery: function (body) {
        const type = String(body.type || '').toLowerCase();
        const schema = SCHEMAS[type];
        if (!schema) return {error: 'type_must_be_person_or_company'};

        const properties = {name: clean(body.name), alias: clean(body.aliases)};
        if (type === 'person') {
            Object.assign(properties, {
                firstName: clean(body.first_name),
                middleName: clean(body.middle_name),
                lastName: clean(body.last_name),
                birthDate: clean(body.birth_date),
                nationality: clean(body.nationality),
                idNumber: clean(body.id_number),
                passportNumber: clean(body.passport_number),
            });
            if (!properties.name.length && !(properties.firstName.length && properties.lastName.length)) {
                return {error: 'name_or_first_and_last_name_required'};
            }
            if (properties.birthDate.some((d) => !DATE_PATTERN.test(d))) {
                return {error: 'birth_date_must_be_yyyy_mm_dd'};
            }
        } else {
            Object.assign(properties, {
                registrationNumber: clean(body.registration_number),
                jurisdiction: clean(body.jurisdiction),
            });
            if (!properties.name.length) return {error: 'name_required'};
        }
        properties.country = clean(body.country);

        for (const key of Object.keys(properties)) {
            if (!properties[key].length) delete properties[key];
        }
        return {query: {schema, properties}};
    },

    /** Our view of one yente result. */
    summarise: function (result) {
        const topics = (result.properties && result.properties.topics) || [];
        return {
            id: result.id,
            name: result.caption,
            schema: result.schema,
            score: result.score,
            match: result.match,
            topics,
            // Only "sanction" itself: "sanction.linked" is a relative or associate of a sanctioned party.
            sanctioned: topics.includes('sanction'),
            pep: hasTopic(topics, 'role.pep'),
            datasets: result.datasets || [],
            url: `https://www.opensanctions.org/entities/${encodeURIComponent(result.id)}/`,
        };
    },

    screen: async function (query) {
        const dataset = process.env.YENTE_DATASET || 'default';
        const threshold = Number(process.env.YENTE_THRESHOLD || 0.7);
        const headers = {'Content-Type': 'application/json'};
        // Only the hosted API (api.opensanctions.org) needs a key; a self-hosted yente doesn't.
        if (process.env.YENTE_API_KEY) headers.Authorization = `ApiKey ${process.env.YENTE_API_KEY}`;

        const res = await axios.post(`${baseUrl()}/match/${encodeURIComponent(dataset)}`, {queries: {q: query}}, {
            params: {threshold, algorithm: process.env.YENTE_ALGORITHM || 'best', limit: 10},
            headers,
            timeout: Number(process.env.YENTE_TIMEOUT_MS || 15000),
        });

        const response = res.data && res.data.responses && res.data.responses.q;
        if (!response || response.status !== 200) {
            throw new Error(`yente answered status ${response ? response.status : 'none'}`);
        }
        const results = response.results.map((r) => this.summarise(r));
        const matches = results.filter((r) => r.match);
        return {
            dataset,
            threshold,
            hit: matches.length > 0,
            sanctioned: matches.some((r) => r.sanctioned),
            pep: matches.some((r) => r.pep),
            matches,
            // Scored below the threshold; worth a look by a person, not a hit.
            near_matches: results.filter((r) => !r.match),
        };
    },
};
