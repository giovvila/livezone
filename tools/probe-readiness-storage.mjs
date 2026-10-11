import {probeStorageWriteability} from '../server/runtime/StorageWriteDiagnostic.js';

// Local administrator/operator command, no HTTP mutation endpoint.
const args=process.argv.slice(2);
try{
    if(args.length!==3||args[0]!=='--directory'||args[2]!=='--authorize-storage-probe')
        throw new Error('Usage: node tools/probe-readiness-storage.mjs --directory <absolute-existing-directory> --authorize-storage-probe');
    console.log(JSON.stringify(await probeStorageWriteability(args[1],{authorizeStorageProbe:true})));
}catch(error){console.error(error.code||error.message);process.exitCode=1;}
