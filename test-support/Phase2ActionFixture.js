import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import ProgramStore from '../server/program-output/ProgramOutputStore.js';
import ProgramRepository from '../server/program-output/DurableProgramRepository.js';
import Coordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ActionRepository from '../server/autolive/ActionTransactionRepository.js';
import ActionModel from '../server/autolive/ActionTransactionModel.js';
import {bindTransferState} from '../server/autolive/ExecutionTransferContract.js';
import {recoveryRecord} from '../server/autolive/ExecutionRecoveryContract.js';

export const fp = 'a'.repeat(64);
export function program(kind = 'media', revision = 1) {
    const at = '2026-01-01T00:00:00.000Z';
    return createProgramOutputEnvelope({version: 1, publisherSessionId: 'publisher', revision, publishedAt: at, committedAt: at,
        scene: {id: kind === 'hls' ? 'LIVE' : 'MEDIA', name: 'Program', type: kind === 'hls' ? 'LIVE' : 'MEDIA'},
        source: {id: kind === 'hls' ? 'live' : 'media', kind, url: 'https://example.test/source'},
        playback: {initialTime: 27, duration: 120, playing: true, ended: false, state: 'playing', startedAt: at},
        graphics: {items: []}, transition: {type: 'cut', durationMs: 0}});
}
export function binding(envelope = program(), generation = 1, fields = {}) {
    return bindTransferState({authorityEpoch: 1, authorityProcessSession: 'process', ownershipRevision: 1,
        durableGeneration: generation, configRevision: 1, manualIntentRevision: 0, recoveryRevision: 0, actionRevision: 0,
        programStatus: 'PRESENT', acceptedProgram: envelope, authorizedSourceId: 'live', sourceFingerprint: fp,
        schedulerExecution: 'SUSPENDED', ...fields});
}
export function action(origin = binding()) {
    return recoveryRecord({actionId: 'action', actionType: 'TAKE', origin, phase: 'BEFORE_RESERVATION', commitStatus: 'NOT_RESERVED',
        authorizedSourceId: origin.authorizedSourceId, sourceFingerprint: origin.sourceFingerprint, configRevision: origin.configRevision,
        manualIntentRevision: origin.manualIntentRevision, authorityEpoch: origin.authorityEpoch, ownershipRevision: origin.ownershipRevision,
        actionRevision: origin.actionRevision, decisionEvidenceDigest: fp,
        decisionEvidence: {kind: 'ACTIVE_PROGRAM', state: 'ONLINE', observedAt: 0, validUntil: 10000, decoderProgress: true},
        returnEligibility: 'CAPTURED', interruptedTarget: {sceneId: 'MEDIA', sourceId: 'media', programIdentity: origin.programIdentity,
            cue: 27, playbackState: 'PLAYING'}});
}
export async function fixture(t, suppliedDirectory) {
    const dir = suppliedDirectory || await mkdtemp(join(tmpdir(), 'lz-phase2-'));
    const path = join(dir, 'action.json'), programPath = join(dir, 'program.json');
    const store = new ProgramStore(), repository = new ProgramRepository({path: programPath});
    const coordinator = new Coordinator({repository, store, validate: async () => true, authorityEpoch: () => 1});
    await coordinator.initialize(); if (!store.getCurrent()) await coordinator.accept(program(), {check: () => true});
    const fields = {}, current = () => binding(store.getCurrent(), repository.record.generation, fields);
    const journal = new ActionRepository({path}); await journal.initialize();
    const model = new ActionModel({repository: journal, current, clock: () => 1000});
    const journals = [journal];
    if (t) t.after(async () => { for (const j of journals.reverse()) await j.close(); await rm(dir, {recursive: true, force: true}); });
    return {dir, path, programPath, store, repository, coordinator, fields, current, journal, model, journals};
}
