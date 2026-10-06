import {createHash} from 'node:crypto';
import {isUtf8} from 'node:buffer';
import {readFile, lstat} from 'node:fs/promises';
import {assertCanonicalPath} from './RecoveryNamespace.js';

const fail = code => {throw Object.assign(new Error(code), {code});};

// Byte identity is always computed before interpretation, from one capture.
// isUtf8 rejects replacement decoding; toString preserves BOM, CRLF, whitespace
// and Unicode exactly. JSON.parse independently rejects BOM and malformed JSON.
export function capturedEvidence(bytes, {text=true, json=false, encodingError='PERSISTENT_EVIDENCE_INVALID_UTF8'}={}) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('EVIDENCE_BUFFER_REQUIRED');
    const evidence={bytes, byteLength:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')};
    if (text || json) {
        if (!isUtf8(bytes)) fail(encodingError);
        evidence.text=bytes.toString('utf8');
    }
    if (json) evidence.value=JSON.parse(evidence.text);
    return evidence;
}

export async function readEvidence(path, {optional=false, maxBytes=64*1024*1024,
    ordinaryError='ORDINARY_EVIDENCE_REQUIRED', ...interpretation}={}) {
    try {
        await assertCanonicalPath(path);
        const stat=await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size>maxBytes) fail(ordinaryError);
        const bytes=await readFile(path);
        if (bytes.length>maxBytes) fail(ordinaryError);
        return capturedEvidence(bytes, interpretation);
    } catch (error) {
        if (optional && error.code==='ENOENT') return null;
        throw error;
    }
}
