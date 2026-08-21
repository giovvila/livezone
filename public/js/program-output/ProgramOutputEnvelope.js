import { validateProgramOutputSnapshot } from "./ProgramOutputContract.js";

export const PROGRAM_OUTPUT_PROTOCOL_VERSION = 1;

export function createProgramOutputEnvelope(snapshot) {
    const valid = validateProgramOutputSnapshot(snapshot);
    if (!valid) return null;
    return Object.freeze({
        protocolVersion: PROGRAM_OUTPUT_PROTOCOL_VERSION,
        publisherSessionId: valid.publisherSessionId,
        revision: valid.revision,
        publishedAt: valid.publishedAt,
        snapshot: valid
    });
}

export function validateProgramOutputEnvelope(candidate) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        candidate.protocolVersion !== PROGRAM_OUTPUT_PROTOCOL_VERSION ||
        typeof candidate.publisherSessionId !== "string" ||
        !candidate.publisherSessionId.trim() ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 ||
        typeof candidate.publishedAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.publishedAt))) return null;

    const snapshot = validateProgramOutputSnapshot(candidate.snapshot);
    if (!snapshot || snapshot.publisherSessionId !== candidate.publisherSessionId ||
        snapshot.revision !== candidate.revision ||
        snapshot.publishedAt !== candidate.publishedAt) return null;

    return Object.freeze({
        protocolVersion: PROGRAM_OUTPUT_PROTOCOL_VERSION,
        publisherSessionId: snapshot.publisherSessionId,
        revision: snapshot.revision,
        publishedAt: snapshot.publishedAt,
        snapshot
    });
}
