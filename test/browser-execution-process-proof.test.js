import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAuthorityProcess,evaluateWindowsAuthorityCensus} from '../server/autolive/WindowsAuthorityProcessProof.js';
export const unrelatedNodes=[
 {ProcessId:101,Name:'node.exe',ExecutablePath:'C:\\Program Files\\Adobe\\Adobe Creative Cloud Experience\\libs\\node.exe',
  CommandLine:'"C:\\Program Files\\Adobe\\Adobe Creative Cloud Experience\\libs\\node.exe" "C:\\Program Files\\Adobe\\Adobe Creative Cloud Experience\\js\\main.js"'},
 {ProcessId:102,Name:'node.exe',ExecutablePath:'C:\\Program Files\\Common Files\\Adobe\\Creative Cloud Libraries\\libs\\node.exe',
  CommandLine:'"C:\\Program Files\\Common Files\\Adobe\\Creative Cloud Libraries\\libs\\node.exe" "C:\\Program Files\\Common Files\\Adobe\\Creative Cloud Libraries\\js\\server.js"'},
 ...['kernel.js','trusted-worker.js'].map((script,index)=>({ProcessId:103+index,Name:'node.exe',
  ExecutablePath:'C:\\Users\\operator\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\version\\bin\\node.exe',
  CommandLine:'"C:\\Users\\operator\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\version\\bin\\node.exe" --experimental-vm-modules "C:\\Users\\operator\\AppData\\Local\\Temp\\.worker\\'+script+'" --working-dir "C:\\Projects\\livezone-broadcast-engine-x"'}))
];
const offline=nodes=>({services:[{State:'Stopped',StartMode:'Disabled'}],nodes});
test('Adobe and Codex entry points are unrelated, including LIVEZONE working-dir arguments',()=>{
 const result=evaluateWindowsAuthorityCensus(offline(unrelatedNodes),{selfPid:9000});
 assert.equal(result.absent,true);assert.deepEqual(result.processes.map(p=>p.kind),['UNRELATED_ADOBE','UNRELATED_ADOBE','UNRELATED_CODEX','UNRELATED_CODEX']);
 assert.equal(JSON.stringify(result).includes('CommandLine'),false);
 assert.equal(evaluateWindowsAuthorityCensus(offline(unrelatedNodes.map(p=>({...p,ProcessId:p.ProcessId+50000}))),{selfPid:9000}).absent,true);
});
for(const entry of ['C:\\Projects\\livezone-broadcast-engine-x\\server\\program-output-server.js','D:\\worktrees\\a1\\server\\program-output-server.js','server/program-output-server.js'])
 test('LIVEZONE server blocks across absolute, worktree and relative entry paths: '+entry,()=>{
  const row={ProcessId:500,Name:'node.exe',ExecutablePath:'C:\\node\\node.exe',CommandLine:'C:\\node\\node.exe --env-file-if-exists=.env "'+entry+'"'};
  assert.equal(classifyAuthorityProcess(row).kind,'LIVEZONE_AUTHORITY');
  assert.equal(evaluateWindowsAuthorityCensus(offline([...unrelatedNodes,row])).absent,false);
 });
for(const service of [{State:'Running',StartMode:'Disabled'},{State:'Stopped',StartMode:'Auto'},{State:'Stopped',StartMode:'Manual'}])
 test('SCM blocks '+service.State+'/'+service.StartMode,()=>assert.equal(evaluateWindowsAuthorityCensus({services:[service],nodes:unrelatedNodes}).absent,false));
test('stray LivezoneNode wrapper blocks despite stopped service',()=>assert.equal(evaluateWindowsAuthorityCensus(offline([
 ...unrelatedNodes,{ProcessId:600,Name:'LivezoneNode.exe',ExecutablePath:'C:\\service\\LivezoneNode.exe',CommandLine:'wrapper'}])).absent,false));
for(const row of [
 {ProcessId:601,Name:'node.exe',ExecutablePath:null,CommandLine:null},
 {...unrelatedNodes[2],CommandLine:unrelatedNodes[2].CommandLine.replace('--experimental-vm-modules','--require C:\\inject.js')},
 {ProcessId:603,Name:'node.exe',ExecutablePath:'C:\\node\\node.exe',CommandLine:'C:\\node\\node.exe -e "require(\'./authority\')"'},
 {ProcessId:604,Name:'node.exe',ExecutablePath:'C:\\node\\node.exe',CommandLine:'C:\\node\\node.exe C:\\unknown\\launcher.js'}
])test('unreadable, injected or unclassified Node entry fails closed '+row.ProcessId,()=>assert.equal(classifyAuthorityProcess(row).blocks,true));
test('vendor executable does not exempt a LIVEZONE entry point',()=>assert.equal(classifyAuthorityProcess({
 ...unrelatedNodes[2],CommandLine:'"'+unrelatedNodes[2].ExecutablePath+'" C:\\Projects\\livezone-broadcast-engine-x\\server\\program-output-server.js'}).blocks,true));
