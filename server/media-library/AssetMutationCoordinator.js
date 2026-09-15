// One process-wide boundary shared by persisted references, runtime leases and deletion.
export default class AssetMutationCoordinator {
    constructor() { this.queue = Promise.resolve(); }
    run(operation) {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => {});
        return result;
    }
}
