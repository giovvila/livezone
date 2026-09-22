import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import SafeHttp, {externalUrl} from '../AutoLiveSafeHttp.js';
import {sha256} from './DecoderEvidenceContract.js';
import DecoderLoopbackOrigin from './DecoderLoopbackOrigin.js';

const inputs = new WeakMap();
const fail = code => { throw Object.assign(Error(code), {code}); };
const boundedError = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'BROKER_FAILURE';

export function remoteReference(value, base) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value) || value.startsWith('//')) fail('REFERENCE_FORBIDDEN');
    let decoded = value;
    try { for (let i = 0; i < 8; i++) { const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next; } } catch { fail('REFERENCE_FORBIDDEN'); }
    if (/%(?:25|2e|2f|5c)/i.test(decoded)) fail('REFERENCE_FORBIDDEN');
    if (decoded.split(/[/?#]/).includes('..') || /[\\\u0000-\u001f]/.test(decoded)) fail('REFERENCE_FORBIDDEN');
    let url; try { url = new URL(value, base); } catch { fail('REFERENCE_FORBIDDEN'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('REFERENCE_FORBIDDEN');
    return url.href;
}
const productionUrl = value => externalUrl(remoteReference(value));

function attributes(text) {
    const out = {}; let rest = text;
    while (rest) {
        const match = /^([A-Z0-9-]+)=("[^"\r\n]*"|[^,]+)(?:,|$)/.exec(rest);
        if (!match || Object.hasOwn(out, match[1])) fail('PLAYLIST_INVALID');
        out[match[1]] = match[2].replace(/^"|"$/g, ''); rest = rest.slice(match[0].length);
    }
    return out;
}
const number = value => { const n = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) fail('PLAYLIST_INVALID'); return n; };

// Deliberately small grammar. No unknown URI-bearing tag can reach the local demuxer.
export function parseDecodePlaylist(text, base) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) fail('BODY_LIMIT');
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(s => s.trim());
    if (lines.shift() !== '#EXTM3U' || lines.length > 4096) fail('PLAYLIST_INVALID');
    const variants = [], segments = []; let pending = null, duration = null, sequence = 0, discontinuity = 0,
        target = 0, map = null, endlist = false, version = 3, date = null, discontinuityCount = 0;
    const seen = new Set();
    for (const line of lines) {
        if (!line) continue;
        if (!line.startsWith('#')) {
            const uri = remoteReference(line, base);
            if (pending) { variants.push({...pending, uri}); pending = null; }
            else {
                if (duration === null || endlist) fail('PLAYLIST_INVALID');
                segments.push({uri, duration, map, date, discontinuity: discontinuity + discontinuityCount});
                duration = null; date = null;
            }
            continue;
        }
        const tag = line.split(':')[0], value = line.slice(tag.length + 1);
        if (['#EXT-X-KEY', '#EXT-X-SESSION-KEY', '#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-MAP'].includes(tag)) {
            const a = attributes(value); if (a.URI) remoteReference(a.URI, base);
            if (tag === '#EXT-X-KEY' && a.METHOD === 'NONE' && Object.keys(a).length === 1) continue;
            if (tag !== '#EXT-X-MAP') fail('HLS_FEATURE_UNSUPPORTED');
            if (!a.URI || Object.keys(a).some(k => k !== 'URI')) fail('HLS_FEATURE_UNSUPPORTED');
            map = remoteReference(a.URI, base); continue;
        }
        if (['#EXT-X-PART', '#EXT-X-PART-INF', '#EXT-X-PRELOAD-HINT', '#EXT-X-RENDITION-REPORT',
            '#EXT-X-SERVER-CONTROL', '#EXT-X-SKIP'].includes(tag)) fail('LL_HLS_UNSUPPORTED');
        if (['#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE', '#EXT-X-DISCONTINUITY-SEQUENCE'].includes(tag)) {
            if (seen.has(tag) || segments.length) fail('PLAYLIST_INVALID'); seen.add(tag);
            const n = number(value);
            if (tag === '#EXT-X-VERSION') { if (n < 1 || n > 7) fail('HLS_FEATURE_UNSUPPORTED'); version = n; }
            if (tag === '#EXT-X-TARGETDURATION') target = n;
            if (tag === '#EXT-X-MEDIA-SEQUENCE') sequence = n;
            if (tag === '#EXT-X-DISCONTINUITY-SEQUENCE') discontinuity = n;
        } else if (tag === '#EXT-X-STREAM-INF') {
            if (pending || duration !== null) fail('PLAYLIST_INVALID'); pending = attributes(value);
            if (!pending.BANDWIDTH || number(pending.BANDWIDTH) < 1 || pending.AUDIO || pending.VIDEO || pending.SUBTITLES) fail('HLS_FEATURE_UNSUPPORTED');
            if(Object.keys(pending).some(k=>!['BANDWIDTH','AVERAGE-BANDWIDTH','CODECS','RESOLUTION','FRAME-RATE','CLOSED-CAPTIONS','PROGRAM-ID'].includes(k)) ||
                pending['CLOSED-CAPTIONS']&&pending['CLOSED-CAPTIONS']!=='NONE')fail('HLS_FEATURE_UNSUPPORTED');
        } else if (tag === '#EXTINF') {
            if (duration !== null || pending) fail('PLAYLIST_INVALID'); duration = Number(value.split(',')[0]);
            if (!Number.isFinite(duration) || duration <= 0 || duration > 30) fail('PLAYLIST_INVALID');
        } else if (tag === '#EXT-X-DISCONTINUITY') discontinuityCount++;
        else if (tag === '#EXT-X-PROGRAM-DATE-TIME') { if (!Number.isFinite(Date.parse(value))) fail('PLAYLIST_INVALID'); date = new Date(value).toISOString(); }
        else if (tag === '#EXT-X-ENDLIST') endlist = true;
        else if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') continue;
        else if (tag === '#EXT-X-PLAYLIST-TYPE' && ['EVENT', 'VOD'].includes(value)) continue;
        else fail('HLS_FEATURE_UNSUPPORTED');
    }
    if (pending || duration !== null || variants.length && segments.length || variants.length > 16) fail('PLAYLIST_INVALID');
    if (variants.length) return {variants};
    if (!segments.length || segments.length > 16 || target < 1 || target > 30 ||
        !Number.isSafeInteger(sequence + segments.length) || !Number.isSafeInteger(discontinuity+discontinuityCount) ||
        segments.reduce((s, x) => s + x.duration, 0) > 90) fail('PLAYLIST_INVALID');
    return {segments, target, sequence, discontinuity, version, endlist};
}

export async function brokerInputInfo(handle) {
    const broker = inputs.get(handle);
    if (!broker || broker.closed || broker.reason || !broker.origin?.url ||
        !/^http:\/\/127\.0\.0\.1:\d+\/input\.m3u8$/.test(broker.origin.url))
        fail('BROKER_INPUT_UNAVAILABLE');
    return {path: broker.origin.url, format: 'hls', transport: 'loopback-http',
        digest: broker.sourceFingerprint, broker: broker.snapshot()};
}
export function brokerInputState(handle) { const broker = inputs.get(handle); return broker?.snapshot() ?? null; }

export default class HlsDecodeInputBroker {
    constructor({endpoint, sourceId, sourceFingerprint, renditionIndex = 0, http = new SafeHttp({parseUrl: productionUrl,validateRedirect:remoteReference}),
    clock = () => Date.now(), maxBytes = 128 * 1024 * 1024, objectBytes = 16 * 1024 * 1024,
    mediaTimeoutMs = 10000}) {
        this.endpoint = remoteReference(endpoint);
if (!/^[a-f0-9]{64}$/.test(sourceFingerprint) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId) ||
    !Number.isInteger(renditionIndex) || renditionIndex < 0 || renditionIndex > 15 ||
    !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024 * 1024 ||
    !Number.isInteger(objectBytes) || objectBytes < 1 || objectBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(mediaTimeoutMs) || mediaTimeoutMs < 2500 || mediaTimeoutMs > 10000
) fail('BROKER_OPTIONS_INVALID');

Object.assign(this, {
    sourceId,
    sourceFingerprint,
    renditionIndex,
    http,
    clock,
    maxBytes,
    objectBytes,
    mediaTimeoutMs
});
        this.generation = randomUUID(); this.contentGeneration = 0; this.records = new Map(); this.objects = new Map();
        this.abort = new AbortController(); this.bytes = 0; this.errors = 0; this.retries = 0; this.input = Object.freeze({kind: 'BROKER_LOCAL_HLS'});
        inputs.set(this.input, this);
    }
    async read(uri, options = {}) {
        for (let attempt = 0; ; attempt++) {
            try { return await this.http.read(uri, {...options, signal:this.abort.signal}); }
            catch (error) {
                if(Number.isSafeInteger(error.receivedBytes))this.failedReceivedBytes=error.receivedBytes;
                if(typeof error.headersReceived==='boolean')this.failedHeadersReceived=error.headersReceived;
                if(['URL','DNS','REQUEST'].includes(error.requestPhase))this.failedRequestPhase=error.requestPhase;
                // Two complete GET attempts at most. No partial-body stitching or retry of
                // policy errors/cancellation. Media objects may use the broker's explicitly
                // bounded per-read deadline; playlists retain the SafeHttp default.
                if (attempt || this.abort.signal.aborted || !['ABORTED','NETWORK_ERROR'].includes(error.code)) throw error;
                ++this.retries; await delay(250, undefined, {signal:this.abort.signal});
            }
        }
    }
    async start() {
        if (this.started || this.closed) fail('BROKER_ALREADY_STARTED'); this.started = true;
        const parent = await realpath(tmpdir()), publicRoot = await realpath(fileURLToPath(new URL('../../../public/',import.meta.url)));
        const fromPublic = relative(publicRoot,parent);
        const outsidePublic=fromPublic==='..'||fromPublic.startsWith(`..${sep}`)||isAbsolute(fromPublic);
        if (/^(?:\\\\|\/\/)/.test(parent) || !outsidePublic) fail('CACHE_PARENT_FORBIDDEN');
        this.root = await mkdtemp(join(parent, 'lz-hls-broker-')); this.root = await realpath(this.root);
        this.origin = new DecoderLoopbackOrigin({
    manifest: () => this.manifest ?? null,
    object: token => {
        const match = /^([a-f0-9]{64})(\.(?:ts|m4s|mp4))$/.exec(token);

        if (!match) return null;

        const [, key, extension] = match;
        const object = this.objects.get(key);

        if (!object) return null;
        if (!object.name.endsWith(extension)) return null;

        const path = join(this.root, object.name);

        if (
            dirname(path) !== this.root ||
            basename(path) !== object.name
        ) {
            return null;
        }

        return {path};
    }
});

await this.origin.start();
        try {
            this.stage = 'MASTER';
            const response = await this.read(this.endpoint);
            const playlist = parseDecodePlaylist(response.body, response.url);
            this.masterIdentity = sha256(this.endpoint);
            if (playlist.variants) {
                const selected = playlist.variants[this.renditionIndex]; if (!selected) fail('RENDITION_UNAVAILABLE');
                this.mediaUrl = selected.uri;
                this.renditionIdentity = sha256(JSON.stringify(selected));
                this.profile = {codecs: /^[a-zA-Z0-9., -]{0,128}$/.test(selected.CODECS || '') ? selected.CODECS || null : null,
                    resolution: /^\d+x\d+$/.test(selected.RESOLUTION || '') ? selected.RESOLUTION : null,
                    bandwidth: number(selected.BANDWIDTH), index: this.renditionIndex};
            } else {
                if (this.renditionIndex !== 0) fail('RENDITION_UNAVAILABLE');
                this.mediaUrl = this.endpoint; this.renditionIdentity = sha256(this.endpoint); this.profile = {codecs: null, resolution: null, index: 0};
            }
            await this.refresh(); return this;
        } catch (error) { this.reason = boundedError(error); this.httpStatus = error.httpStatus ?? null;
            await this.close(); throw Object.assign(Error(this.reason), {code: this.reason}); }
    }
    async object(uri, extension) {
        const key = sha256(uri); if (this.objects.has(key)) return this.objects.get(key);
        this.stage = extension === '.mp4' ? 'INIT' : 'SEGMENT';
        const response = await this.read(uri, {
    binary: true,
    maxBytes: this.objectBytes,
    stage: 'decode-object',
    timeoutMs: this.mediaTimeoutMs
});
        if (!response.bytes || !Buffer.isBuffer(response.body)) fail('MEDIA_OBJECT_INVALID');
        // Prevent nested playlists or arbitrary local-reference formats masquerading as segments.
        const body = response.body;
        if (extension === '.ts' ? !(body.length >= 564 && body[0] === 0x47 && body[188] === 0x47 && body[376] === 0x47) :
            !(body.length >= 8 && (extension === '.mp4' ? ['ftyp'] : ['styp', 'moof', 'emsg']).includes(body.toString('ascii', 4, 8))))
            fail('MEDIA_CONTAINER_UNSUPPORTED');
        if (this.bytes + response.bytes > this.maxBytes || this.objects.size >= 64) fail('CACHE_LIMIT');
        const name = `${randomUUID()}${extension}`, path = join(this.root, name);
        await writeFile(path, response.body, {flag: 'wx', mode: 0o600});
        const object = {key, name, bytes: response.bytes, digest: sha256(response.body)};
        this.objects.set(key, object); this.bytes += object.bytes;
        this.peakBytes=Math.max(this.peakBytes||0,this.bytes);this.peakObjects=Math.max(this.peakObjects||0,this.objects.size);return object;
    }
    async refresh() {
        if (this.closed || this.reason) fail('BROKER_CLOSED'); if (this.pending) return this.pending;
        this.pending = this.update().catch(error => { this.reason = boundedError(error); this.httpStatus = error.httpStatus ?? null;
            ++this.errors; throw Object.assign(Error(this.reason), {code: this.reason}); });
        try { return await this.pending; } finally { this.pending = null; }
    }
    async update() {
        this.stage = 'MEDIA';
        const response = await this.read(this.mediaUrl);
        const playlist = parseDecodePlaylist(response.body, response.url);
        if (playlist.variants) fail('NESTED_MASTER_UNSUPPORTED');
        const end = playlist.sequence + playlist.segments.length - 1;
        if (this.lastEnd !== undefined && (end < this.lastEnd || playlist.sequence < this.lastSequence || playlist.discontinuity < this.lastDiscontinuity)) fail('MEDIA_SEQUENCE_REGRESSED');
        const retained = new Map(), needed = new Set(), output = ['#EXTM3U', `#EXT-X-VERSION:${playlist.version}`,
            `#EXT-X-TARGETDURATION:${playlist.target}`, `#EXT-X-MEDIA-SEQUENCE:${playlist.sequence}`,
            `#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.segments[0].discontinuity}`];
        let lastMap = null, lastDiscontinuity = playlist.segments[0].discontinuity;
        for (let i = 0; i < playlist.segments.length; i++) {
            const segment = playlist.segments[i], n = playlist.sequence + i;
            const init = segment.map ? await this.object(segment.map, '.mp4') : null;
            const object = await this.object(segment.uri, init ? '.m4s' : '.ts');
            if (!this.records.has(n) && [...this.records.values()].some(record => record.keys[0] === object.key)) fail('SEGMENT_URI_REUSED');
            const signature = JSON.stringify([object.digest, init?.digest, segment.duration, segment.discontinuity]);
            if (this.records.has(n) && this.records.get(n).signature !== signature) fail('ACCEPTED_MEDIA_CHANGED');
            retained.set(n, {signature, keys: [object.key, ...(init ? [init.key] : [])]}); needed.add(object.key); if (init) needed.add(init.key);
            while(segment.discontinuity>lastDiscontinuity){output.push('#EXT-X-DISCONTINUITY');lastDiscontinuity++;}
            if (init && init.key !== lastMap) {
                output.push(`#EXT-X-MAP:URI="/media/${init.key}.mp4"`);
                lastMap = init.key;
            }
            if (segment.date) output.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.date}`);
            const extension = init ? '.m4s' : '.ts';
            output.push(
                `#EXTINF:${segment.duration},`,
                `/media/${object.key}${extension}`
            );
        }
        if (playlist.endlist) output.push('#EXT-X-ENDLIST');
        const body = output.join('\n') + '\n';
        this.stage = 'LOCAL_UPDATE';
        if (this.closed || this.abort.signal.aborted) fail('ABORTED');
        if (body !== this.manifest) {
    this.manifest = body;
    ++this.contentGeneration;
}
        // Keep the current and preceding window. A decoder that falls further behind fails closed.
        for (const record of this.records.values()) for (const key of record.keys) needed.add(key);
        for (const [key, object] of this.objects) if (!needed.has(key)) {
            await rm(join(this.root, object.name)); this.objects.delete(key); this.bytes -= object.bytes;
        }
        if (this.objects.size > 64) fail('CACHE_LIMIT');
        const now = this.clock(); if (this.lastEnd === undefined || end > this.lastEnd) this.lastAdvance = now;
        this.lastEnd = end; this.lastSequence = playlist.sequence; this.lastDiscontinuity = playlist.discontinuity;
        this.records = retained; this.target = playlist.target; this.endlist = playlist.endlist;
        this.discontinuity = lastDiscontinuity; this.refreshedAt = now;
        return this.snapshot();
    }
    snapshot() {
        const stale = this.lastAdvance === undefined || this.clock() - this.lastAdvance > Math.max(15000, (this.target || 1) * 3000);
        return Object.freeze({brokerGeneration: this.generation, brokerContentGeneration: this.contentGeneration,
            masterIdentity: this.masterIdentity || null, renditionIdentity: this.renditionIdentity || null,
            sourceId: this.sourceId, sourceFingerprint: this.sourceFingerprint, profile: this.profile || null,
            targetDuration: this.target || null, llHls: false, endlist: Boolean(this.endlist),
            mediaSequence: this.lastSequence ?? null, endSequence: this.lastEnd ?? null, discontinuity: this.discontinuity ?? 0,
            refreshedAt: this.refreshedAt ?? null, lastAdvance: this.lastAdvance ?? null,
            ready: !this.closed && !this.reason && !stale, reason: this.reason || (this.closed ? 'BROKER_CLOSED' : stale ? 'PLAYLIST_STALE' : 'BROKER_READY'),
            bytes: this.bytes, objects: this.objects.size, errors: this.errors, retries:this.retries, stage: this.stage || null, httpStatus: this.httpStatus ?? null,
            peakBytes:this.peakBytes||0,peakObjects:this.peakObjects||0,
            failedReceivedBytes:this.failedReceivedBytes??null,failedHeadersReceived:this.failedHeadersReceived??null,
            failedRequestPhase:this.failedRequestPhase??null,
            executionAllowed: false, serverTake: false, transferReady: false});
    }
    async close() {
        if (this.closePromise) return this.closePromise;

        this.closed = true;
        this.abort.abort();

        this.closePromise = (async () => {
            let drainTimedOut = false;

            if (this.pending) {
                const drained = await Promise.race([
                    this.pending.then(() => true, () => true),
                    delay(2000).then(() => false)
                ]);
                drainTimedOut = !drained;
            }

            await this.origin?.close();

            if (this.root) {
                const root = resolve(this.root), parent = await realpath(tmpdir());
                if (dirname(root) !== parent || !/^lz-hls-broker-/.test(basename(root))) fail('CACHE_CLEANUP_FORBIDDEN');
                await rm(root, {recursive: true, force: true});
            }

            this.bytes = 0;
            this.objects.clear();

            if (drainTimedOut) fail('PENDING_DRAIN_TIMEOUT');
        })();

        return this.closePromise;
    }
}
