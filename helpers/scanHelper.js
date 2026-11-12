/**
 * What the passport and ID card scans share: the picture the app took, and what the SDK says about itself.
 */
const fs = require('fs');
const path = require('path');

const maxImageBytes = () => Number(process.env.PASSPORT_MAX_IMAGE_KB || 2048) * 1024;

/** The JPEG from the app: base64, with or without a data: prefix. Null if it isn't a usable JPEG. */
function decodeImage(value) {
    if (typeof value !== 'string' || !value) return null;
    const buffer = Buffer.from(value.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    // JPEG files start FF D8 FF.
    if (buffer.length < 1024 || buffer.length > maxImageBytes() || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
    return buffer;
}

/** Only the few things the SDK reports about itself; anything else is dropped. */
function deviceInfo(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const key of ['sdk', 'sdk_version', 'platform', 'os_version', 'scan_ms', 'frames']) {
        const v = value[key];
        if (typeof v === 'string') out[key] = v.slice(0, 64);
        else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

/** The client's own ID for the person: undefined/null → null, a usable string, or false if it's invalid. */
function reference(value) {
    if (value === undefined || value === null) return null;
    const r = String(value).trim();
    return r && r.length <= 255 ? r : false;
}

/** <dir>/<publicId>.jpg. Returns the file name, or null if it couldn't be written. */
async function saveImage(dir, publicId, buffer) {
    try {
        await fs.promises.mkdir(dir, {recursive: true});
        const name = `${publicId}.jpg`;
        await fs.promises.writeFile(path.join(dir, name), buffer);
        return name;
    } catch (err) {
        console.error(`Could not save the picture for ${publicId}:`, err.message);
        return null;
    }
}

module.exports = {decodeImage, deviceInfo, reference, saveImage};
