import {open, mkdir, unlink, realpath, lstat} from 'node:fs/promises';
import {renameSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {dirname, resolve, relative, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../program-output/DurableProgramContract.js';
import {actionEnvelope, validateActionEnvelope} from './ActionTransactionModel.js';

const MAX_BYTES = 32768;
const inside = (root, path) => { const r = relative(root, path); return !r || !r.startsWith('..') && !isAbsolute(r); };
const fail = code => { throw Object.assign(Error(code), {code}); };
// Isolated opt-in journal: no default/live path, no API, no browser import, no Program writer.
export default class ActionTransactionRepository {
    constructor({path, publicRoot = resolve('public'), hook = () => {}}) {
        if (typeof path !== 'string' || !isAbsolute(path) || inside(resolve(publicRoot), resolve(path))) fail('PRIVATE_ACTION_PATH_REQUIRED');
        Object.assign(this, {path: resolve(path), publicRoot: resolve(publicRoot), hook});
        this.status = 'UNAVAILABLE'; this.record = null; this.queue = Promise.resolve();
    }
    async initialize() {
        if (this.initializing) return this.initializing;
        this.initializing = this.initializeOnce(); return this.initializing;
    }
    async initializeOnce() {
        let file;
        try {
            await mkdir(dirname(this.path), {recursive: true});
            const directory = await realpath(dirname(this.path));
            const publicPath = await realpath(this.publicRoot).catch(() => this.publicRoot);
            if (inside(publicPath, directory)) fail('PRIVATE_ACTION_PATH_REQUIRED');
            this.lock = await open(this.path + '.lock', 'wx', 0o600);
            await this.lock.writeFile(JSON.stringify({version: 1, processSession: randomUUID()})); await this.lock.sync();
            try { if ((await lstat(this.path)).isSymbolicLink()) fail('ACTION_CORRUPT'); file = await open(this.path, 'r'); }
            catch (error) { if (error.code === 'ENOENT') { this.status = 'READY'; return; } throw error; }
            if (!(await file.stat()).isFile() || (await file.stat()).size > MAX_BYTES) fail('ACTION_CORRUPT');
            const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
            while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
            if (size > MAX_BYTES) fail('ACTION_CORRUPT');
            this.record = validateActionEnvelope(JSON.parse(buffer.subarray(0, size).toString('utf8'))).record;
            this.status = 'READY';
        } catch (error) { this.status = error.code === 'EEXIST' ? 'LOCKED' : 'CORRUPT'; this.record = null; }
        finally { if (file) await file.close(); }
    }
    write(expectedRevision, record, check) {
        const run = this.queue.then(() => this.writeOnce(expectedRevision, record, check));
        this.queue = run.catch(() => {}); return run;
    }
    async writeOnce(expectedRevision, record, check) {
        if (this.closed || this.status !== 'READY' || !this.lock) fail('ACTION_UNAVAILABLE');
        if ((this.record?.actionRevision || 0) !== expectedRevision || record.actionRevision !== expectedRevision + 1) fail('ACTION_REVISION_CONFLICT');
        const envelope = actionEnvelope(record), bytes = Buffer.from(canonical(envelope) + '\n');
        const prior = this.record, next = envelope.record;
        const edges = {NONE: ['RESERVED'], RESERVED: ['COMMITTING'], COMMITTING: ['PROGRAM_COMMITTED'],
            PROGRAM_COMMITTED: ['ACTIVE'], ACTIVE: ['RETURN_PENDING'], RETURN_PENDING: ['COMPLETED']};
        if (!(edges[prior?.state || 'NONE'] || []).includes(next.state) &&
            !(prior && edges[prior.state] && ['ABORTED','RECOVERY_BLOCKED'].includes(next.state))) fail('INVALID_ACTION_TRANSITION');
        if (prior && (canonical(prior.action) !== canonical(next.action) || prior.reservedAt !== next.reservedAt ||
            ['commitIntent','returnIntent','programCommit'].some(k => prior[k] !== null && canonical(prior[k]) !== canonical(next[k])))) fail('ACTION_IDENTITY_CHANGED');
        if (bytes.length > MAX_BYTES) fail('ACTION_TOO_LARGE');
        const temp = this.path + '.' + randomUUID() + '.tmp'; let file, replacing = false;
        try {
            if (!check()) fail('STALE_ACTION_CAS');
            file = await open(temp, 'wx', 0o600); this.hook('opened');
            let offset = 0; while (offset < bytes.length) {
                const {bytesWritten} = await file.write(bytes, offset, bytes.length - offset, null);
                if (!bytesWritten) fail('ACTION_SHORT_WRITE'); offset += bytesWritten;
            }
            this.hook('written'); await file.sync(); this.hook('flushed'); await file.close(); file = null;
            this.hook('staged');
            if (this.closed || !check()) fail('STALE_ACTION_CAS');
            // This is only the action journal's commit point, not a Program/ownership transaction.
            this.hook('before-replace'); replacing = true; renameSync(temp, this.path); this.hook('replaced');
            const fd = openSync(this.path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
            this.record = envelope.record; this.hook('installed'); return this.record;
        } catch (error) { if (replacing) this.status = 'RECOVERY_BLOCKED'; throw error; }
        finally { if (file) await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
    }
    async close() {
        this.closed = true; await this.initializing; await this.queue;
        if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.path + '.lock'); }
    }
}
