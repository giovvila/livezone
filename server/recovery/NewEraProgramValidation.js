import {readEvidence} from './PersistentEvidence.js';
import {validateRecord} from '../program-output/DurableProgramContract.js';
import ProgramRestoreValidation from '../program-output/ProgramRestoreValidation.js';
import {validateAuthoritativeState} from '../studio/AuthoritativeStateContract.js';
import MediaAssetRepository from '../media-library/MediaAssetRepository.js';
import {dirname} from 'node:path';
import {fail} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';

// Read-only counterpart of runtime initialization. In particular, never call
// MediaAssetRepository.initialize(), which can create directories/manifests.
export async function validateNewEraProgram(paths){
    if(!paths.studio||!paths.mediaManifest||!paths.configuration)fail('NEW_ERA_PROGRAM_CATALOG_EVIDENCE_REQUIRED');
    const [program,studio,manifest,config]=await Promise.all([paths.program,paths.studio,paths.mediaManifest,paths.configuration].map(p=>readEvidence(p,{json:true})));
    const state=validateAuthoritativeState(studio.value);
    if(!state?.initialized||manifest.value.version!==1||!Array.isArray(manifest.value.assets))fail('NEW_ERA_PROGRAM_CATALOG_INVALID');
    const assets=new MediaAssetRepository({root:dirname(paths.mediaManifest)});
    for(const candidate of manifest.value.assets){const asset=assets.validateAsset(candidate);if(!asset||assets.assets.has(asset.id))fail('NEW_ERA_PROGRAM_ASSET_INVALID');assets.assets.set(asset.id,asset);}
    const validator=new ProgramRestoreValidation({catalog:()=>state,assets,resolveConfigRef:ref=>typeof ref==='string'&&/^[a-zA-Z0-9_.]+$/.test(ref)?ref.split('.').reduce((v,k)=>v&&Object.hasOwn(v,k)?v[k]:null,config.value):null});
    if(!await validator.validate(validateRecord(program.value)))fail('NEW_ERA_PROGRAM_IDENTITY_UNRESOLVED');
    return true;
}
