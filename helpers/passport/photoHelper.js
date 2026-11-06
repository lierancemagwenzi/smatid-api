/**
 * Turns a passport chip's face picture into a JPEG. Many chips (Zimbabwe's among them) store it as
 * JPEG 2000, which browsers, Flutter and most image tools can't show. Decoding is done by OpenJPEG
 * (the reference decoder, compiled to WebAssembly) and the JPEG is written with jpeg-js.
 */
const jpeg = require('jpeg-js');

let decoderLib = null;

/** Loads the WebAssembly decoder once. Its progress messages are kept off the console. */
function openjpeg() {
    if (!decoderLib) {
        const factory = require('@cornerstonejs/codec-openjpeg/decodewasmjs');
        decoderLib = (typeof factory === 'function' ? factory : factory.default)({print: () => {}, printErr: () => {}});
    }
    return decoderLib;
}

/**
 * A JP2 file holds boxes; the picture itself is the codestream in the "jp2c" box. A bare codestream
 * (starting FF 4F FF 51) is passed through. Also returns the colour space from the "colr" box, if any.
 */
function codestreamOf(buf) {
    if (buf[0] === 0xff && buf[1] === 0x4f) return {codestream: buf, colourSpace: null};
    let pos = 0;
    let colourSpace = null;
    const read = (start, end) => {
        let p = start;
        while (p + 8 <= end) {
            let length = buf.readUInt32BE(p);
            const type = buf.toString('latin1', p + 4, p + 8);
            let header = 8;
            if (length === 1) {
                length = Number(buf.readBigUInt64BE(p + 8));
                header = 16;
            } else if (length === 0) {
                length = end - p;
            }
            if (length < header || p + length > end) throw new Error('JP2 box runs past the end');
            if (type === 'jp2c') return buf.subarray(p + header, p + length);
            // jp2h is a box of boxes; colr in it says the colour space.
            if (type === 'jp2h') {
                const inner = read(p + header, p + length);
                if (inner) return inner;
            }
            if (type === 'colr' && buf[p + header] === 1) colourSpace = buf.readUInt32BE(p + header + 3);
            p += length;
        }
        return null;
    };
    const codestream = read(pos, buf.length);
    if (!codestream) throw new Error('no JPEG 2000 codestream found');
    return {codestream, colourSpace};
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * JPEG 2000 → {jpeg, width, height}. Handles colour (sRGB or sYCC) and greyscale, 8 or 16 bits.
 * Throws if the picture can't be decoded.
 */
async function jp2ToJpeg(buf, {quality = 90} = {}) {
    const {codestream, colourSpace} = codestreamOf(Buffer.from(buf));
    const lib = await openjpeg();
    const decoder = new lib.J2KDecoder();
    try {
        decoder.getEncodedBuffer(codestream.length).set(codestream);
        decoder.decode();
        const {width, height, bitsPerSample, componentCount} = decoder.getFrameInfo();
        const decoded = decoder.getDecodedBuffer();
        if (!width || !height || ![1, 3, 4].includes(componentCount)) throw new Error(`unsupported picture: ${componentCount} components`);

        // Samples are interleaved; over 8 bits they're 16-bit little-endian.
        const wide = bitsPerSample > 8;
        const samples = wide ? new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2) : decoded;
        const shift = wide ? bitsPerSample - 8 : 0;
        const at = (i) => (shift ? samples[i] >> shift : samples[i]);
        const sYcc = colourSpace === 18;

        const rgba = Buffer.alloc(width * height * 4);
        for (let px = 0; px < width * height; px++) {
            const s = px * componentCount;
            let r;
            let g;
            let b;
            if (componentCount === 1) {
                r = g = b = at(s);
            } else if (sYcc) {
                const y = at(s);
                const cb = at(s + 1) - 128;
                const cr = at(s + 2) - 128;
                r = clamp(y + 1.402 * cr);
                g = clamp(y - 0.344136 * cb - 0.714136 * cr);
                b = clamp(y + 1.772 * cb);
            } else {
                r = at(s);
                g = at(s + 1);
                b = at(s + 2);
            }
            const o = px * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
        }
        return {jpeg: jpeg.encode({data: rgba, width, height}, quality).data, width, height};
    } finally {
        if (decoder.delete) decoder.delete();
    }
}

/** The JPEG's size, read from its SOF marker, without decoding it. */
function jpegSize(buf) {
    let p = 2;
    while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) return null;
        const marker = buf[p + 1];
        const length = buf.readUInt16BE(p + 2);
        // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return {height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7)};
        }
        p += 2 + length;
    }
    return null;
}

/**
 * The chip's picture as a JPEG, whatever it came as. Returns {jpeg, width, height, converted}, or
 * {error} when a JPEG 2000 couldn't be decoded, in which case only the original is kept.
 */
async function toJpeg(photo) {
    if (photo.format === 'jpeg') {
        const size = jpegSize(Buffer.from(photo.data)) || {};
        return {jpeg: Buffer.from(photo.data), width: size.width || null, height: size.height || null, converted: false};
    }
    try {
        const out = await jp2ToJpeg(photo.data);
        return {...out, converted: true};
    } catch (err) {
        return {error: err.message || String(err)};
    }
}

module.exports = {toJpeg, jp2ToJpeg, codestreamOf, jpegSize};
