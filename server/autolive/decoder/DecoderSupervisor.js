import FFmpegHealthWorker from './FFmpegHealthWorker.js';

export function restartDelay(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1000) throw Error('INVALID_RESTART_ATTEMPT');
    return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}

// Explicit experiment lifecycle. No autonomous acquisition, retry loop or application bootstrap wiring.
export default class DecoderSupervisor {
    constructor(options) { this.options = {...options}; this.generation = 0; this.restartGeneration = 0; this.nextStartAt = 0; }
    async start(onObservation = () => {}) {
        if (this.busy || this.worker) throw Error('ONE_WORKER_LIMIT');
        if (this.restartGeneration >= 3) throw Error('EXPERIMENT_RESTART_LIMIT');
        if (Date.now() < this.nextStartAt) throw Error('RESTART_BACKOFF');
        this.busy = true;
        const worker = new FFmpegHealthWorker({...this.options, workerGeneration: ++this.generation,
            restartGeneration: this.restartGeneration});
        this.worker = worker;
        worker.on('observation', onObservation);
        worker.once('closed', () => {
            if (this.worker === worker) { this.worker = null; this.nextStartAt = Date.now() + restartDelay(this.restartGeneration++); }
        });
        try { await worker.start(); return worker; }
        catch (error) {
            if (this.worker === worker) this.worker = null;
            this.nextStartAt = Date.now() + restartDelay(this.restartGeneration++); throw error;
        } finally { this.busy = false; }
    }
    async stop() { if (this.worker) return this.worker.stop(); }
}
