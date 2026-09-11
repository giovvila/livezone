// Compatibility export: all HLS health consumers share one implementation.
export { createLiveHlsConsumerFactory as createDominantLiveConsumerFactory,
    LIVE_PROGRESS_STALL_MS } from "./LiveHlsHealthConsumer.js";
