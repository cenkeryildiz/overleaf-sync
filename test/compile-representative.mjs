// Run inside compiler service. Uses only disposable multi-file text/math/figure/bibliography jobs.
import assert from 'node:assert/strict';import Docker from 'dockerode';import{randomBytes}from'node:crypto';import fs from'node:fs/promises';import{execFileSync}from'node:child_process';
const docker=new Docker(),jobs=Array.from({length:Number(process.env.REPR_USERS||5)},()=>({id:randomBytes(12).toString('hex'),user:randomBytes(12).toString('hex')})),samples=[];
const dir=j=>`/var/lib/overleaf/data/compiles/${j.id}-${j.user}`;
const tex=marker=>String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,bbm,tikz,graphicx}
\begin{document}
\section{${marker}}\label{sec:first}
A citation \cite{synthetic2026} and reference to Section~\ref{sec:first}.
\begin{align}x_1 &= \frac{a+1}{b+2} \\ x_2 &= \mathbbm{1}+\alpha^2\end{align}
\begin{tikzpicture}\draw[->] (0,0)--(6,0);\draw[->] (0,0)--(0,3);\draw[blue,thick,domain=0:5,samples=120] plot(\x,{sin(\x r)+1.5});\end{tikzpicture}
\input{sections/body}
\bibliographystyle{plain}\bibliography{references}
\end{document}
`;
const resources=marker=>[{path:'main.tex',content:tex(marker)},{path:'sections/body.tex',content:('Realistic text with math $x^2+y^2=z^2$, accents café and financial reasoning. '.repeat(20)+'\n\n').repeat(16)},{path:'references.bib',content:'@article{synthetic2026,author={Example, Alice},title={Synthetic Bibliography},journal={Test Journal},year={2026}}'}];
let stop=false,maxMemory=0,maxPids=0,maxActive=0;const watch=(async()=>{while(!stop){const live=(await docker.listContainers({filters:{label:['com.cenker.overleaf.worker=ws1']}})).filter(c=>jobs.some(j=>c.Names.some(n=>n.includes(j.id))));maxActive=Math.max(maxActive,live.length);for(const item of live){try{const stats=await docker.getContainer(item.Id).stats({stream:false,'one-shot':true});maxMemory=Math.max(maxMemory,stats.memory_stats.usage||0);maxPids=Math.max(maxPids,stats.pids_stats.current||0);}catch{}}await new Promise(r=>setTimeout(r,50));}})();
try{
 const responses=await Promise.all(jobs.map(async(job,i)=>{const start=performance.now(),r=await fetch(`http://127.0.0.1:3013/project/${job.id}/user/${job.user}/compile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({compile:{options:{compiler:'pdflatex',compileGroup:'standard',timeout:30,stopOnFirstError:true},rootResourcePath:'main.tex',resources:resources('RepresentativeJob'+i)}}),signal:AbortSignal.timeout(65000)});return{http:r.status,body:await r.json(),ms:performance.now()-start}}));
 for(let i=0;i<responses.length;i++){const response=responses[i];assert.equal(response.http,200,JSON.stringify(response.body).slice(0,200));const diagnostic=await fs.readFile(dir(jobs[i])+'/output.log','utf8').catch(()=> 'log unavailable');const lines=diagnostic.split('\n'),first=lines.findIndex(line=>line.startsWith('!'));assert.equal(response.body.compile.status,'success',lines.slice(Math.max(0,first-1),first+8).join('\n'));const text=execFileSync('pdftotext',[dir(jobs[i])+'/output.pdf','-'],{encoding:'utf8'});assert(text.includes('RepresentativeJob'+i));assert(/Synthetic bibliography/i.test(text));assert(!text.includes('??'),'Unresolved reference');assert(text.normalize('NFC').includes('café'));const log=await fs.readFile(dir(jobs[i])+'/output.log','utf8');assert(!log.includes('Citation `synthetic2026\' on page')&&!log.includes('There were undefined references'),'Bibliography/crossrefs incomplete');samples.push(Math.round(response.ms));}
 assert(maxActive<=4,'Queue exceeded configured slots');console.log(JSON.stringify({passed:true,users:jobs.length,samplesMs:samples,observedMaxActive:maxActive,sampledJobMemoryBytes:maxMemory,sampledJobPids:maxPids,sourceInputs:'multi-file, math, TikZ, 120 plot samples, bibliography, crossrefs, repeated text'}));
}finally{stop=true;await watch;const all=await docker.listContainers({all:true});for(const c of all)if(jobs.some(j=>c.Names.some(n=>n.startsWith('/project-'+j.id+'-'+j.user+'-'))))await docker.getContainer(c.Id).remove({force:true});for(const j of jobs){await fs.rm(dir(j),{recursive:true,force:true});await fs.rm(`/var/lib/overleaf/data/output/${j.id}-${j.user}`,{recursive:true,force:true});}}
