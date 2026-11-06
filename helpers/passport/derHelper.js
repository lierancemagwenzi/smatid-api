/**
 * A small DER (ASN.1) reader: enough to walk a passport's EF.SOD, a CSCA master list and DG1/DG2.
 * Each node keeps its exact bytes, which matters for signatures: what was signed has to be hashed
 * byte for byte, not re-encoded.
 */

class DerError extends Error {
    constructor(message) {
        super(message);
        this.code = 'der_invalid';
    }
}

/** Reads one TLV at `offset` of `buf`. Tags above 30 (multi-byte, as in passport files) are supported. */
function read(buf, offset = 0, end = buf.length) {
    if (offset >= end) throw new DerError('unexpected end of data');
    const start = offset;
    const first = buf[offset++];
    const cls = first >> 6;
    const constructed = Boolean(first & 0x20);
    // The full tag as a number, e.g. 0x30, 0xA0, 0x5F1F, 0x7F61.
    let tag = first;
    if ((first & 0x1f) === 0x1f) {
        let b;
        do {
            if (offset >= end) throw new DerError('tag runs past the end');
            b = buf[offset++];
            tag = tag * 256 + b;
        } while (b & 0x80);
    }
    if (offset >= end) throw new DerError('missing length');
    let length = buf[offset++];
    if (length === 0x80) throw new DerError('indefinite length is not DER');
    if (length & 0x80) {
        const count = length & 0x7f;
        if (count > 4 || offset + count > end) throw new DerError('bad length');
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + buf[offset++];
    }
    const valueStart = offset;
    const valueEnd = valueStart + length;
    if (valueEnd > end) throw new DerError('value runs past the end');
    return new Node(buf, tag, cls, constructed, start, valueStart, valueEnd);
}

class Node {
    constructor(buf, tag, cls, constructed, start, valueStart, end) {
        Object.assign(this, {buf, tag, cls, constructed, start, valueStart, end});
    }

    /** The whole TLV. */
    get bytes() {
        return this.buf.subarray(this.start, this.end);
    }

    get value() {
        return this.buf.subarray(this.valueStart, this.end);
    }

    get children() {
        if (this._children) return this._children;
        const out = [];
        let pos = this.valueStart;
        while (pos < this.end) {
            const child = read(this.buf, pos, this.end);
            out.push(child);
            pos = child.end;
        }
        this._children = out;
        return out;
    }

    child(i, expectedTag) {
        const c = this.children[i];
        if (!c) throw new DerError(`missing element ${i}`);
        if (expectedTag !== undefined && c.tag !== expectedTag) {
            throw new DerError(`element ${i}: expected tag ${expectedTag.toString(16)}, got ${c.tag.toString(16)}`);
        }
        return c;
    }

    /** The first child with this tag, or null. */
    find(tag) {
        return this.children.find((c) => c.tag === tag) || null;
    }

    get oid() {
        if (this.tag !== 0x06) throw new DerError('not an OID');
        const v = this.value;
        const parts = [];
        let n = 0;
        for (let i = 0; i < v.length; i++) {
            n = n * 128 + (v[i] & 0x7f);
            if (!(v[i] & 0x80)) {
                if (!parts.length) parts.push(n < 80 ? Math.floor(n / 40) : 2, n < 80 ? n % 40 : n - 80);
                else parts.push(n);
                n = 0;
            }
        }
        return parts.join('.');
    }

    /** A small INTEGER as a number. */
    get int() {
        if (this.tag !== 0x02) throw new DerError('not an INTEGER');
        let n = 0;
        for (const b of this.value) n = n * 256 + b;
        return n;
    }
}

/** Parses a whole buffer that must be exactly one TLV. */
function parse(buf) {
    const node = read(buf, 0, buf.length);
    if (node.end !== buf.length) throw new DerError('trailing data');
    return node;
}

module.exports = {parse, read, DerError};
