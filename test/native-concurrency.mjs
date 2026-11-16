// Run inside the existing container: docker exec -i -w /overleaf/services/clsi sharelatex node --input-type=module < test/native-concurrency.mjs
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const base='http://127.0.0.1:3013',jobs=Array.from({length:3},()=>({id:randomBytes(12).toString('hex'),user:randomBytes(12).toString('hex')}));
const results={jobs:jobs.map(j=>({id:j.id,user:j.user})),checks:[]};
const dir=j=>`/var/lib/overleaf/data/compiles/${j.id}-${j.user}`;
const source=(marker,delay=false)=>String.raw`\documentclass{article}
\begin{document}
${delay?String.raw`\pdfresettimer\loop\ifnum\pdfelapsedtime<327680 \repeat`:''}
${marker} $x^2+1$.
\end{document}
`;
async function compile(job,text,extra=[]){const started=performance.now();const response=await fetch(`${base}/project/${job.id}/user/${job.user}/compile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({compile:{options:{compiler:'pdflatex',timeout:15,stopOnFirstError:true},rootResourcePath:'main.tex',resources:[{path:'main.tex',content:text},...extra]}}),signal:AbortSignal.timeout(25000)});return {http:response.status,body:await response.json(),ms:performance.now()-started};}
const check=async(name,fn)=>{if(process.env.ONLY_FAULT&&name!=='owned worker SIGKILL and subsequent recovery')return;try{results.checks.push({name,passed:true,...await fn()})}catch(e){results.checks.push({name,passed:false,error:e.message.slice(0,200)})}};
try{
 await check('three simultaneous native jobs and repeated progress',async()=>{const samples=[];for(let round=0;round<3;round++){const batch=await Promise.all(jobs.map((j,i)=>compile(j,source(`Job${i}Round${round}`))));for(let i=0;i<batch.length;i++){assert.equal(batch[i].http,200);assert.equal(batch[i].body.compile.status,'success',JSON.stringify(batch[i].body).slice(0,300));const text=execFileSync('pdftotext',[dir(jobs[i])+'/output.pdf','-'],{encoding:'utf8'});assert(text.includes(`Job${i}Round${round}`));assert(!text.includes(`Job${(i+1)%3}Round`));}samples.push(batch.map(r=>Math.round(r.ms)));}return {roundsMs:samples};});
 await check('cross-project synthetic input denied',async()=>{const secret='SyntheticPrivate'+randomBytes(8).toString('hex');await compile(jobs[0],source('Owner'),[{path:'private.txt',content:secret}]);const tex=String.raw`\documentclass{article}
\begin{document}
\newread\probe\openin\probe=${dir(jobs[0])}/private.txt
\ifeof\probe Denied\else\read\probe to\stolen\stolen\fi
\closein\probe\end{document}
`;const response=await compile(jobs[1],tex);let leaked=false;try{leaked=execFileSync('pdftotext',[dir(jobs[1])+'/output.pdf','-'],{encoding:'utf8'}).includes(secret);}catch{}assert(!leaked,'Native compiler read another job synthetic private.txt');return {status:response.body.compile?.status,leaked:false};});
 await check('owned worker SIGKILL and subsequent recovery',async()=>{const job=jobs[2],pending=compile(job,source('BeforeWorkerKill',true));let victim;
 const until=Date.now()+8000;while(!victim&&Date.now()<until){for(const pid of (await fs.readdir('/proc')).filter(p=>/^\d+$/.test(p))){try{const command=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).replaceAll('\0',' ');const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(command.includes('latexmk')&&command.includes(dir(job))&&Number(rest[2])===Number(pid)){victim=Number(pid);break;}}catch{}}if(!victim)await new Promise(r=>setTimeout(r,25));}if(!victim){const absent=await pending;throw Error('Owned compilation process not found; status='+absent.body.compile?.status);}process.kill(-victim,'SIGKILL');const killed=await pending;assert.notEqual(killed.body.compile?.status,'success','Killed worker reported successful compilation');const recovered=await compile(job,source('AfterWorkerRecovery'));assert.equal(recovered.body.compile.status,'success');const text=execFileSync('pdftotext',[dir(job)+'/output.pdf','-'],{encoding:'utf8'});assert(text.includes('AfterWorkerRecovery')&&!text.includes('BeforeWorkerKill'));return {failureStatus:killed.body.compile?.status,recoveredMs:Math.round(recovered.ms)};});
}finally{for(const job of jobs){await fs.rm(dir(job),{recursive:true,force:true});await fs.rm(`/var/lib/overleaf/data/output/${job.id}-${job.user}`,{recursive:true,force:true});}console.log(JSON.stringify(results));if(results.checks.some(c=>!c.passed))process.exitCode=1;}
