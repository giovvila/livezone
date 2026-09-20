const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/\/+/g,'/').toLowerCase();
// Census evidence, not a PID allowlist. Unknown/unreadable launchers fail closed.
export function classifyAuthorityProcess(row,{selfPid=process.pid}={}){
 const pid=Number(row.ProcessId),executable=normalize(row.ExecutablePath);
 if(pid===selfPid)return {pid,kind:'MAINTENANCE_SELF'};
 if(String(row.Name||'').toLowerCase()==='livezonenode.exe'||executable.endsWith('/livezonenode.exe'))return {pid,kind:'LIVEZONE_WRAPPER',blocks:true};
 if(!Number.isSafeInteger(pid)||pid<1||!executable||typeof row.CommandLine!=='string'||!row.CommandLine.trim())return {pid,kind:'UNREADABLE_PROCESS',blocks:true};
 const tokens=Array.from(row.CommandLine.matchAll(/"([^"]*)"|(\S+)/g),match=>normalize(match[1]??match[2]));
 if(tokens.some(token=>/(?:^|\/)program-output-server\.(?:js|mjs|cjs)$/.test(token)||token.includes('browserexecutionownership')))
  return {pid,kind:'LIVEZONE_AUTHORITY',blocks:true};
 if(tokens[0]!==executable)return {pid,kind:'AMBIGUOUS_EXECUTABLE',blocks:true};
 let index=1;
 // The one non-injecting host option used by the inspected Codex runtime.
 while(tokens[index]==='--experimental-vm-modules')index++;
 const entry=tokens[index]||'';
 if(entry.startsWith('-'))return {pid,kind:'UNREVIEWED_NODE_OPTIONS',blocks:true};
 let kind;
 const adobe=executable.match(/^(.*\/adobe\/(?:adobe creative cloud experience|creative cloud libraries))\/libs\/node\.exe$/);
 if(adobe&&(entry===adobe[1]+'/js/main.js'||entry===adobe[1]+'/js/server.js'))kind='UNRELATED_ADOBE';
 const codex=executable.match(/^(.*\/appdata\/local)\/openai\/codex\/runtimes\/[^/]+\/[^/]+\/bin\/node\.exe$/);
 if(codex&&entry.startsWith(codex[1]+'/temp/')&&/\/(?:kernel|trusted-worker)\.js$/.test(entry))kind='UNRELATED_CODEX';
 return {pid,kind:kind||'UNCLASSIFIED_NODE_ENTRY',executable,entry,blocks:!kind};
}
export function evaluateWindowsAuthorityCensus(value,options={}){
 if(!Array.isArray(value?.services)||!Array.isArray(value?.nodes))return {absent:false,reason:'incomplete OS census'};
 const processes=value.nodes.map(row=>classifyAuthorityProcess(row,options));
 const serviceSafe=value.services.every(s=>s.State==='Stopped'&&s.StartMode==='Disabled');
 const absent=serviceSafe&&!processes.some(row=>row.blocks);
 return {absent,reason:!serviceSafe?'LivezoneNode must be stopped and maintenance-disabled':
  absent?'LIVEZONE absent; unrelated application entry points verified':'LIVEZONE or ambiguous authority process present',services:value.services,processes};
}
