import {lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {currentCompatibility,ordinary,sha} from './PermanentCapabilityContract.js';
import {helperSha256,gateSha256} from '../scheduler/WindowsLedgerDurability.js';

// Compare an existing durability attestation with current read-only metadata.
// This describes previously certified capability, not a newly performed flush.
export function verifiedCapabilityStorage(directory,proof,proofDirectory){
    const fail=()=>{throw Object.assign(Error('NEW_ERA_VERIFIED_STORAGE_REQUIRED'),{code:'NEW_ERA_VERIFIED_STORAGE_REQUIRED'});};
    if(proof?.status!=='PERMANENT DEPLOYABLE PROOF VALID'||proof.identity!=='S-1-5-18'||
        !/^[a-f0-9]{64}$/.test(proof.proofHash??'')||proof.helperSha256!==helperSha256||proof.gateSha256!==gateSha256)fail();
    directory=resolve(directory);
    // Reject junctions/mount points rather than infer their volume from a drive.
    for(let path=directory;;path=dirname(path)){
        const stat=lstatSync(path);
        if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path).toLowerCase()!==path.toLowerCase())fail();
        if(dirname(path)===path)break;
    }
    // Rebind these metadata to the same verified manifest bytes. A bundle swap
    // between proof verification and storage comparison fails closed.
    if(!proofDirectory)fail();
    const bytes=ordinary(join(resolve(proofDirectory),'manifest.json'));
    if(sha(bytes)!==proof.proofHash)fail();
    const manifest=JSON.parse(bytes),{machine,volume}=currentCompatibility(directory);
    if(JSON.stringify(machine)!==JSON.stringify(manifest.machine)||volume.volumeSerial!==manifest.volumeSerial||
        volume.volume!==proof.volume||volume.filesystem!=='NTFS'||volume.local!==true||
        !Number.isSafeInteger(volume.volumeSerial)||volume.volumeSerial<0||volume.volumeSerial>0xffffffff)fail();
    return Object.freeze({helper:'livezone-windows-ledger-durability',version:'1.0.0',protocol:1,architecture:'x64',
        command:'capability',ok:true,directory,volume:volume.volume,volumeSerial:volume.volumeSerial,
        filesystem:'NTFS',local:true,barrier:'NTFS_DIRECTORY_FLUSH'});
}
