const axios = require('axios');

// Old numbers look like 1234/2010, new ones like 38043A0242025.
const NUMBER_PATTERN = /^[A-Za-z0-9/-]{3,30}$/;

function baseUrl() {
    return (process.env.CIPZ_BASE_URL || 'https://cipz.pfms.gov.zw:8090').replace(/\/+$/, '');
}

function decodeEntities(text) {
    return text
        .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

module.exports = {
    isValidNumber: function (number) {
        return NUMBER_PATTERN.test(number || '');
    },

    /**
     * Reads the CIPZ "check a company" page. The register shows each field as an <h4>:
     *   Name: EXPRESS SMATPAY
     *   Number: 38043A0242025 (PRIVATE) LIMITED   <- the name's suffix lands on the number line
     *   Address: ...
     *   Verified
     * An unknown number gets a "Something went wrong" page, still with status 200.
     * Returns {found: true, ...} or {found: false}; throws on a page it doesn't recognise.
     */
    parsePage: function (html) {
        const lines = [...html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)]
            .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        // The status is the first unlabelled line after the fields; later <h4>s are the page footer.
        const fields = {};
        let status = null;
        for (const line of lines) {
            const m = line.match(/^(Name|Number|Address)\s*:\s*(.*)$/i);
            if (m) fields[m[1].toLowerCase()] = m[2].trim();
            else if (Object.keys(fields).length) {
                status = line;
                break;
            }
        }

        if (fields.name === undefined && fields.number === undefined) {
            if (/Something went wrong/i.test(html)) return {found: false};
            throw new Error('Unrecognised CIPZ page');
        }

        const [number = '', ...suffix] = (fields.number || '').split(' ');
        const name = [fields.name, ...suffix].filter(Boolean).join(' ');
        return {
            found: true,
            name,
            number,
            address: fields.address || null,
            status,
            verified: /^verified$/i.test(status || ''),
        };
    },

    checkCompany: async function (number) {
        // The register reads the number from a nameless query parameter: ?=38043A0242025
        const url = `${baseUrl()}/Info/Checkacompany?=${encodeURIComponent(number)}`;
        const res = await axios.get(url, {
            timeout: Number(process.env.CIPZ_TIMEOUT_MS || 15000),
            responseType: 'text',
            headers: {Accept: 'text/html'},
        });
        return this.parsePage(res.data);
    },
};
