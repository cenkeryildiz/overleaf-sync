// Run in installed candidate with docker exec -i --user www-data sharelatex node --input-type=module.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync,spawn} from 'node:child_process';
assert(process.getuid()!==0,'Use actual unprivileged compile-service identity');
const root=await mkdtemp('/var/lib/overleaf/data/compiles/confinement-'),other=await mkdtemp('/var/lib/overleaf/data/compiles/confinement-peer-');
const bin='/opt/overleaf-native-tex/bin/overleaf-compile-sandbox',results=[];
function run(code,args=[]){const r=spawnSync(bin,[root,root,'/opt/overleaf-native-perl/bin/perl','-e',code,...args],{env:{...process.env,PRIVATE_PROBE:'synthetic-secret'},encoding:'utf8',timeout:10000});return {status:r.status,signal:r.signal,error:r.error?.message,stderr:r.stderr?.slice(0,200),stdout:r.stdout};}
function check(name,fn){try{fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message.slice(0,300)})}}
let peer;
try{
 await writeFile(other+'/private.txt','SyntheticPrivateOnly');
 check('own files and child exec remain usable',()=>{const r=run('open my $out, ">", "owned.txt" or die $!; print $out "owned"; close $out; system("/bin/echo", "child-ok"); exit($? == 0 ? 0 : 1)');assert.equal(r.status,0,JSON.stringify(r));assert(r.stdout.includes('child-ok'));});
 check('sibling read denied',()=>{const r=run('open my $in, "<", $ARGV[0] and exit 1; exit 0',[other+'/private.txt']);assert.equal(r.status,0,JSON.stringify(r));});
 check('sibling write denied',()=>{const r=run('open my $out, ">", $ARGV[0] and exit 1; exit 0',[other+'/private.txt']);assert.equal(r.status,0,JSON.stringify(r));});assert.equal(await readFile(other+'/private.txt','utf8'),'SyntheticPrivateOnly');
 check('application environment removed',()=>{const r=run('exit(exists $ENV{PRIVATE_PROBE} ? 1 : 0)');assert.equal(r.status,0,JSON.stringify(r));});
 check('socket creation denied',()=>{const r=run('use Socket; exit(socket(my $s, PF_INET, SOCK_STREAM, 6) ? 1 : 0)');assert.equal(r.status,0,JSON.stringify(r));});
 peer=spawn('/bin/sleep',['20']);check('signals outside job denied',()=>{const r=run('exit(kill("USR1", $ARGV[0]) ? 1 : 0)',[String(peer.pid)]);assert.equal(r.status,0,JSON.stringify(r));});
 check('process-group escape denied',()=>{const r=run('use POSIX; exit(POSIX::setsid() >= 0 ? 1 : 0)');assert.equal(r.status,0,JSON.stringify(r));});
}finally{peer?.kill('SIGKILL');await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});console.log(JSON.stringify({checks:results}));if(results.some(r=>!r.passed))process.exitCode=1;}
