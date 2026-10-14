import fs from 'node:fs';
import {dirname,join,resolve,parse} from 'node:path';
import {createHash} from 'node:crypto';

const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=b=>createHash('sha256').update(b).digest('hex');
// No default target, host or verifier. Only the separately authorized CLI supplies
// production adapters; tests supply isolated TEMP adapters, never CLI overrides.
export function assertOrdinaryChain(target) {
    let current=resolve(target);
    for (;;) {
        try { const s=fs.lstatSync(current);
            if(s.isSymbolicLink()||fs.realpathSync(current).toLowerCase()!==current.toLowerCase())fail('INSTALL_REPARSE_PATH');
            if(current!==resolve(target)&&!s.isDirectory())fail('INSTALL_NON_DIRECTORY_ANCESTOR');
        } catch(e) { if(e.code!=='ENOENT')throw e; }
        const parent=dirname(current);if(parent===current)break;current=parent;
    }
}
export async function installPermanentProof({source,destination,expectedHash,verify,security,host,hook=()=>{}}) {
    if(host?.platform!=='win32'||host?.administrator!==true||host?.serviceIdentity!=='LocalSystem')fail('INSTALL_ADMIN_SYSTEM_WINDOWS_REQUIRED');
    if(!/^[a-f0-9]{64}$/.test(expectedHash||''))fail('INSTALL_EXPLICIT_HASH_REQUIRED');
    source=resolve(source);destination=resolve(destination);
    if(source===destination||parse(source).root.toLowerCase()!==parse(destination).root.toLowerCase())fail('INSTALL_SAME_VOLUME_REQUIRED');
    assertOrdinaryChain(source);assertOrdinaryChain(destination);
    const sourceProof=await verify(source);
    if(sourceProof.proofHash!==expectedHash)fail('INSTALL_PROOF_HASH_MISMATCH');
    const manifestBytes=fs.readFileSync(join(source,'manifest.json'));
    if(sha(manifestBytes)!==expectedHash)fail('INSTALL_PROOF_HASH_MISMATCH');
    const manifest=JSON.parse(manifestBytes);
    if(destination.split(/[\\/]/).at(-1)!==manifest.probeId)fail('INSTALL_DESTINATION_IDENTITY');
    const wanted=new Map([['manifest.json',manifestBytes]]);
    for(const a of manifest.artifacts) {
        if(!/^[a-z0-9.-]+$/.test(a.name)||wanted.has(a.name))fail('INSTALL_ARTIFACT_NAME');
        const file=join(source,a.name),st=fs.lstatSync(file);
        if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('INSTALL_SOURCE_FILE');
        const bytes=fs.readFileSync(file);if(sha(bytes)!==a.sha256)fail('INSTALL_SOURCE_CHANGED');wanted.set(a.name,bytes);
    }
    if(wanted.size!==12||fs.readdirSync(source).length!==12)fail('INSTALL_BUNDLE_COMPLETENESS');
    const parent=dirname(destination),stage=join(parent,'.install-'+manifest.probeId+'-'+expectedHash+'.stage');
    const verifyExact=async directory=>{
        assertOrdinaryChain(directory);
        if((await verify(directory)).proofHash!==expectedHash)fail('INSTALL_POST_PROOF_MISMATCH');
        await security.verify(directory,true);
        for(const name of wanted.keys())await security.verify(join(directory,name),false);
    };
    // Existing final is NEVER repaired, merged or overwritten, including its ACLs.
    if(fs.existsSync(destination)) {
        if(fs.existsSync(stage))fail('INSTALL_STAGING_REVIEW_REQUIRED');
        await security.verifyParent(parent);
        await verifyExact(destination);
        return {status:'EXISTING_MATCHING',proofHash:expectedHash,destination,mutated:false};
    }
    if(fs.existsSync(stage))fail('INSTALL_STAGING_REVIEW_REQUIRED');
    await hook('before-staging');
    const missing=[];
    try {
        // Parent creation is explicit, one level at a time with a protected descriptor.
        // Existing parents must be safely owned and have no nonprivileged write ACE.
        let ancestor=parent;
        while(!fs.existsSync(ancestor)){missing.unshift(ancestor);const up=dirname(ancestor);if(up===ancestor)fail('INSTALL_PARENT');ancestor=up;}
        await security.verifyParent(ancestor);
        for(const directory of missing) {assertOrdinaryChain(directory);await security.createDirectory(directory);await security.verify(directory,true);}
        await security.verifyParent(parent);
        assertOrdinaryChain(stage);await security.createDirectory(stage);await security.verify(stage,true);
        for(const [name,bytes] of wanted) {
            assertOrdinaryChain(stage);await security.verify(stage,true);
            await hook('before-copy',name);
            const file=join(stage,name),fd=fs.openSync(file,'wx');
            try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
            await security.protectFile(file);await security.verify(file,false);
            await hook('copied',name);
        }
        await hook('pre-publish');
        if((await verify(source)).proofHash!==expectedHash)fail('INSTALL_SOURCE_CHANGED');
        await verifyExact(stage);
        assertOrdinaryChain(destination);await security.verifyParent(parent);
        if(fs.existsSync(destination))fail('INSTALL_DESTINATION_APPEARED');
        await hook('publish');
        // Windows Directory.Move refuses an existing target; sibling rename is
        // atomic namespace publication, NOT a claimed NTFS durability barrier.
        await security.publish(stage,destination);
        await hook('post-publish');await verifyExact(destination);
        return {status:'INSTALLED_VERIFIED',proofHash:expectedHash,destination,parentsCreated:missing,files:[...wanted.keys()],acl:'VERIFIED',mutated:true};
    } catch(error) {
        // Retain all evidence. No automatic delete, rollback or promotion on retry.
        error.installState={stage,destination,parentsCreated:missing.filter(p=>fs.existsSync(p)),stagePresent:fs.existsSync(stage),finalPresent:fs.existsSync(destination),remediation:'STOP: independently inspect retained state; no automatic cleanup'};
        throw error;
    }
}
