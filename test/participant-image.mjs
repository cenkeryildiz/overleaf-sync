// Read-only image comparison: run Node through docker --entrypoint without a server, network or volumes.
import { readdir, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const files = {};
async function hash(path) { const h=createHash('sha256'); for await(const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }
async function visit(path, prefix) {
 for(const entry of await readdir(path,{withFileTypes:true})) {
  const p=path+'/'+entry.name, key=prefix+'/'+entry.name;
  if(entry.isDirectory()) await visit(p,key);
  else files[key]=entry.isSymbolicLink()?'link:'+await readlink(p):await hash(p);
 }
}
await visit('/overleaf/services/web/public','public');
for(const p of [
 '/opt/participant/overleaf-participant-coordinator', '/etc/overleaf/settings.js', '/etc/overleaf/participant-base.cjs',
 '/overleaf/services/web/app/src/router.mjs', '/etc/nginx/templates/overleaf.conf.template',
 ...['ParticipantCompile','SessionCheckpoint','ParticipantArtifacts','CompileManager','LivePreview'].map(name=>'/overleaf/services/web/app/src/Features/Compile/'+name+'.mjs'),
 '/overleaf/services/web/app/src/Features/Email/EmailSender.mjs', '/overleaf/services/clsi/app/js/CompileManager.js',
 ...['Router','SessionSockets'].map(name=>'/overleaf/services/real-time/app/js/'+name+'.js'),
 ...['OIDCAuthenticationManager','OIDCAuthenticationController'].map(name=>'/overleaf/services/web/modules/authentication/oidc/app/src/'+name+'.mjs'),
]) files[p]=await hash(p);
const probe=spawnSync('/opt/participant/overleaf-participant-coordinator',[],{input:JSON.stringify({id:1,op:'status',job:'opt19-probe',now:0})+'\n',encoding:'utf8',timeout:5000});
assert.equal(probe.status,0,probe.error?.message||probe.stderr);
assert.equal(JSON.parse(probe.stdout).value.state,'missing');
console.log(JSON.stringify({coordinatorRuns:true,files}));
