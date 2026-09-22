import {spawn} from 'node:child_process';
import {readFile, realpath, stat} from 'node:fs/promises';
import {isAbsolute, relative, sep, extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {DecoderEvidence, PROFILES, sha256} from './DecoderEvidenceContract.js';
import {brokerInputInfo, brokerInputState} from './HlsDecodeInputBroker.js';

let activeWorker = null;

export const spawnOptions = () => ({shell: false, windowsHide: true,
    env: process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot || 'C:\\Windows'} : {LANG: 'C'},
    stdio: ['pipe', 'pipe', 'pipe']});

export function parseVersion(text) {
    const version = /^ffmpeg version ([^\r\n]{1,160})/m.exec(text)?.[1];
    const configuration = /^configuration:([^\r\n]*)/m.exec(text)?.[1].trim();
    if (!version || !configuration || configuration.length > 8192) throw Error('BACKEND_PROVENANCE_UNAVAILABLE');
    return {version, configuration};
}
export async function verifyBackend({path, digest}) {
    if (!isAbsolute(path) || path.startsWith('\\\\') || !/^[a-f0-9]{64}$/.test(digest)) throw Error('INVALID_BACKEND');
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024 * 1024 || sha256(await readFile(path)) !== digest) throw Error('BACKEND_DIGEST_MISMATCH');
    const output = await new Promise((resolve, reject) => {
        const child = spawn(path, ['-version'], spawnOptions()); let text = '', settled = false;
        const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(text); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('BACKEND_VERSION_TIMEOUT')); }, 5000);
        const data = chunk => { text += chunk.toString(); if (text.length > 16384) { child.kill('SIGKILL'); finish(Error('BACKEND_VERSION_BOUNDS')); } };
        child.stdout.on('data', data); child.stderr.on('data', data);
        child.once('error', () => finish(Error('BACKEND_SPAWN_FAILED')));
        child.once('close', code => finish(code === 0 ? null : Error('BACKEND_VERSION_FAILED')));
        child.stdin.end();
    });
    return Object.freeze({...parseVersion(output), digest});
}

export async function localFixture(root, path) {
    if (typeof root !== 'string' || !isAbsolute(root) || typeof path !== 'string' || !isAbsolute(path) ||
        /^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(path) || /^(?:\\\\|\/\/)/.test(root) ||
        path.split(/[\\/]/).includes('..') || /:/.test(path.replace(/^[A-Za-z]:/, ''))) throw Error('LOCAL_FIXTURE_REQUIRED');
    const actualRoot = await realpath(root), actual = await realpath(path), rel = relative(actualRoot, actual);
    if (/^(?:\\\\|\/\/)/.test(actualRoot) || /^(?:\\\\|\/\/)/.test(actual) ||
        !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('FIXTURE_OUTSIDE_ROOT');
    const info = await stat(actual), extension = extname(actual).toLowerCase();
    if (!info.isFile() || info.size > 16 * 1024 * 1024 || !['.mkv', '.wav'].includes(extension)) throw Error('FIXTURE_FORMAT_OR_SIZE');
    return {path: actual, digest: sha256(await readFile(actual)), format: extension === '.wav' ? 'wav' : 'matroska'};
}
export function decoderArguments(fixture, profile) {
    if (!Object.hasOwn(PROFILES, profile)) throw Error('INVALID_TRACK_PROFILE');

    const brokerLoopback = fixture.format === 'hls' &&
        fixture.transport === 'loopback-http' &&
        fixture.broker &&
        /^http:\/\/127\.0\.0\.1:\d+\/input\.m3u8$/.test(fixture.path);

    if (fixture.format === 'hls' && !brokerLoopback) throw Error('BROKER_LOOPBACK_REQUIRED');

    const protocols = brokerLoopback ? 'file,http,tcp' : 'file';
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-xerror', '-threads', '2',
        '-filter_threads', '1', '-filter_complex_threads', '1', '-protocol_whitelist', protocols,
        '-format_whitelist', fixture.format === 'hls' ? 'hls,mpegts,mov' : fixture.format, '-f', fixture.format,
        ...(fixture.format === 'hls' ? ['-allowed_extensions', 'ts,m4s,mp4', '-live_start_index', '-1'] : []),
        '-re', '-i', fixture.path];
    // Explicit required maps: missing tracks are errors, never optional downgrade.
    if (PROFILES[profile].includes('video')) args.push('-map', '0:v:0', '-vf', 'showinfo=checksum=0');
    if (PROFILES[profile].includes('audio')) args.push('-map', '0:a:0', '-af', 'ashowinfo');
    return [...args, '-threads', '2', '-f', 'null', '-'];
}

// Parses only generated telemetry fields; raw input messages never leave the worker.
export function decodedLine(line) {
    const audio = line.includes('Parsed_ashowinfo_'), video = line.includes('Parsed_showinfo_');
    if (!audio && !video || !/\bn:\s*\d+/.test(line)) return null;
    const pts = Number(/\bpts_time:([-+\d.e]+)/.exec(line)?.[1]);
    if (!Number.isFinite(pts)) return null;
    if (audio) {
        const count = Number(/\bnb_samples:(\d+)/.exec(line)?.[1]);
        const signature = ['fmt', 'channels', 'chlayout', 'rate'].map(k => new RegExp(`\\b${k}:([^ ]+)`).exec(line)?.[1] ?? '').join(':');
        return count > 0 ? {kind: 'audio', pts, count, signature} : null;
    }
    return {kind: 'video', pts, count: 1,
        signature: ['fmt', 's', 'sar'].map(k => new RegExp(`\\b${k}:([^ ]+)`).exec(line)?.[1] ?? '').join(':')};
}

export class BoundedLines {
    constructor(onLine, onLimit, {maxLine = 4096, maxBytes = 8 * 1024 * 1024,
        maxRate = 256 * 1024, clock = () => performance.now()} = {}) {
        Object.assign(this, {onLine, onLimit, maxLine, maxBytes, maxRate, clock});
        this.pending = ''; this.total = 0; this.windowAt = clock(); this.windowBytes = 0; this.exceeded = false;
    }
    push(chunk) {
        if (this.exceeded) return;
        const now = this.clock(); if (now - this.windowAt >= 1000) { this.windowAt = now; this.windowBytes = 0; }
        this.total += chunk.length; this.windowBytes += chunk.length;
        if (this.total > this.maxBytes || this.windowBytes > this.maxRate) return this.limit();
        this.pending += chunk.toString('utf8');
        const lines = this.pending.split(/\r?\n/); this.pending = lines.pop();
        for (const line of lines) { if (line.length > this.maxLine) return this.limit(); this.onLine(line); }
        if (this.pending.length > this.maxLine) this.limit();
    }
    limit() { this.exceeded = true; this.pending = ''; this.onLimit(); }
}

export default class FFmpegHealthWorker extends EventEmitter {
    constructor({backend, fixtureRoot, fixturePath, brokerInput = null, sourceId = 'local-fixture', profile,
        workerGeneration = 1, restartGeneration = 0, maxRuntimeMs = 180000}) {
        super();
        if (!Object.hasOwn(PROFILES, profile) || !Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1000 || maxRuntimeMs > (brokerInput ? 600000 : 180000) ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId) || !Number.isSafeInteger(workerGeneration) || workerGeneration < 1 ||
            !Number.isSafeInteger(restartGeneration) || restartGeneration < 0)
            throw Error('INVALID_WORKER_OPTIONS');
        Object.assign(this, {backendConfig: {...backend}, fixtureRoot, fixturePath, brokerInput, sourceId, profile,
            workerGeneration, restartGeneration, maxRuntimeMs});
        this.diagnostics = []; this.started = false; this.stopping = false;
    }
    diagnostic(code) {
        this.diagnostics.push({code, at: Date.now()}); if (this.diagnostics.length > 64) this.diagnostics.shift();
    }
    stopBounded(force = false) { void this.stop(force).catch(() => this.diagnostic('TERMINATION_UNCONFIRMED')); }
    publish() {
        if (this.brokerInput && !this.evidence.closed) this.evidence.updateBroker(brokerInputState(this.brokerInput));
        const sample = this.evidence.snapshot(); this.emit('observation', sample); return sample;
    }
    async start() {
        if (this.started) throw Error('WORKER_ALREADY_STARTED'); this.started = true;
        if (activeWorker) throw Error('ONE_WORKER_LIMIT');
        activeWorker = this;
        let fixture, backend;
        try {
            fixture = this.brokerInput ? await brokerInputInfo(this.brokerInput) : await localFixture(this.fixtureRoot, this.fixturePath);
            backend = await verifyBackend(this.backendConfig);
            if (fixture.broker && fixture.broker.sourceId !== this.sourceId) throw Error('BROKER_SOURCE_MISMATCH');
            if (this.stopping) throw Error('WORKER_CANCELLED');
        } catch (error) { activeWorker = null; throw error; }
        this.evidence = new DecoderEvidence({sourceId: this.sourceId, sourceFingerprint: fixture.digest, backend,
            workerId: randomUUID(), workerGeneration: this.workerGeneration, restartGeneration: this.restartGeneration, profile: this.profile, broker: fixture.broker});
        this.publish();
        this.child = spawn(this.backendConfig.path, decoderArguments(fixture, this.profile), spawnOptions());
        this.pid = this.child.pid;
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        const limit = () => { this.evidence.fail('DECODER_UNAVAILABLE', 'OUTPUT_LIMIT'); this.diagnostic('OUTPUT_LIMIT'); this.stopBounded(true); };
        const lines = new BoundedLines(line => {
            const decoded = decodedLine(line);
            if (decoded) this.evidence.ingest({...decoded, workerGeneration: this.workerGeneration, restartGeneration: this.restartGeneration});
            if (/matches no streams|Unknown decoder|Decoder .* not found/.test(line)) this.unavailable = true;
        }, limit);
        const stdout = new BoundedLines(() => {}, limit);
        this.child.stderr.on('data', chunk => lines.push(chunk));
        this.child.stdout.on('data', chunk => stdout.push(chunk));
        this.child.stdin.on('error', () => {});
        this.child.once('error', () => { this.evidence.fail('DECODER_UNAVAILABLE', 'SPAWN_FAILED'); this.diagnostic('SPAWN_FAILED'); });
        this.child.once('close', (code, signal) => {
            clearInterval(this.poll); clearTimeout(this.deadline); clearTimeout(this.runtime); clearTimeout(this.forceTimer);
            if (!['DECODER_UNAVAILABLE', 'DECODER_ERROR'].includes(this.evidence.state)) {
                this.evidence.fail(this.stopping ? 'DECODER_UNCERTAIN' : code === 0 ? 'DECODER_ENDED' :
                    this.unavailable ? 'DECODER_UNAVAILABLE' : 'DECODER_ERROR',
                this.stopping ? 'WORKER_STOPPED' : code === 0 ? 'NATURAL_END' : this.unavailable ? 'REQUIRED_PROFILE_UNAVAILABLE' : 'DECODE_OR_PROCESS_FAILURE');
            }
            this.evidence.close(this.evidence.state, this.evidence.reason);
            if (activeWorker === this) activeWorker = null;
            const sample = this.publish(); this.diagnostic('PROCESS_CLOSED');
            this.resolveClosed({code, signal, sample, pid: this.pid}); this.emit('closed', sample);
        });
        this.poll = setInterval(() => {
            const sample = this.publish(); if (sample.state === 'DECODER_PROGRESS') clearTimeout(this.deadline);
        }, 500);
        this.deadline = setTimeout(() => {
            this.evidence.fail('DECODER_UNAVAILABLE', 'STARTUP_TIMEOUT'); this.stopBounded(true);
        }, 15000);
        this.runtime = setTimeout(() => {
            this.evidence.fail('DECODER_UNAVAILABLE', 'EXPERIMENT_TIME_LIMIT'); this.stopBounded();
        }, this.maxRuntimeMs);
        return this;
    }
    async stop(force = false) {
        this.stopping = true;
        if (this.evidence && !['DECODER_ERROR', 'DECODER_UNAVAILABLE', 'DECODER_ENDED'].includes(this.evidence.state))
            this.evidence.close('DECODER_UNCERTAIN', 'WORKER_STOPPED');
        if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
        if (force) this.child.kill('SIGKILL');
        else {
            // FFmpeg's own local console command allows graceful stop on Windows.
            this.child.stdin.write('q\n');
            if (!this.forceTimer) this.forceTimer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
        }
        if (!this.stopPromise) {
            let timer;
            this.stopPromise = Promise.race([this.closed, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(Error('TERMINATION_UNCONFIRMED')), 5000);
            })]).finally(() => clearTimeout(timer));
        }
        // On timeout keep the slot fenced until a real close event; never claim cleanup succeeded.
        return this.stopPromise;
    }
}
