import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename,resolve,relative,isAbsolute} from 'node:path';
let root;
export function writeTempDiagnostic(name,bytes) {
    if (!name || name === '.' || name === '..' || basename(name) !== name) throw new Error('Diagnostic name must be a basename');
    if (!root) {
        root = mkdtempSync(join(tmpdir(),'lz-test-diagnostics-'));
        process.once('exit',()=> { const rel=relative(resolve(tmpdir()),resolve(root));
            if(rel.startsWith('lz-test-diagnostics-')&&!rel.startsWith('..')&&!isAbsolute(rel)) rmSync(root,{recursive:true,force:true}); });
    }
    const path=join(root,name);writeFileSync(path,bytes);return path;
}
