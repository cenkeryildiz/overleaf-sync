import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=mkdtempSync('/tmp/native-tex-check-'),output='/native-tex-check';mkdirSync(output);
const tex=String.raw`\documentclass{exam}
\usepackage{amsmath,amssymb,mathtools,siunitx,booktabs,xcolor,tcolorbox}
\begin{document}
\section*{Synthetic qualification}
\begin{align}
x_1 &= \frac{a+1}{b+2} \\
x_2 &= \frac{c+3}{d+4} \\
x_3 &= \frac{e+5}{f+6}
\end{align}
\begin{questions}\question Synthetic problem with a solution.\begin{solution}Answer with $\alpha+\beta=\gamma$.\end{solution}\end{questions}
${('A synthetic paragraph for realistic text layout, accents café, and repeated typesetting. '.repeat(8)+'\n\n').repeat(28)}
NativeMarker0000
\end{document}
`;
const results={sourceBytes:Buffer.byteLength(tex),engines:{}};
for(const [label,path] of [['previous','/usr/local/texlive/2026/bin/x86_64-linux'],['native-pdftex','/opt/overleaf-native-tex/bin'],['native','/opt/overleaf-native-tex/bin']]){
 const dir=join(root,label);mkdirSync(dir);const env={...process.env,PATH:path+':'+process.env.PATH,HOME:dir,SOURCE_DATE_EPOCH:'1794700800',FORCE_SOURCE_DATE:'1'};
 const samples=[],pdfHashes=[],memoryKiB=[];
 for(let i=0;i<4;i++){
  writeFileSync(join(dir,'main.tex'),tex.replace('NativeMarker0000','NativeMarker'+String(i).padStart(4,'0')));
  const start=performance.now();
  const command=label==='native-pdftex'?['/usr/bin/perl','/usr/local/texlive/2026/texmf-dist/scripts/latexmk/latexmk.pl']:['latexmk'];
  execFileSync('/usr/bin/time',['-f','%M','-o',join(dir,'memory.txt'),...command,'-pdf','-synctex=1','-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,env,stdio:'pipe'});
  samples.push(performance.now()-start);memoryKiB.push(Number(readFileSync(join(dir,'memory.txt'),'utf8').trim()));
  const bytes=readFileSync(join(dir,'main.pdf'));pdfHashes.push(createHash('sha256').update(bytes).digest('hex'));writeFileSync(join(output,label+'-'+i+'.pdf'),bytes);
 }
 const bad=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','-jobname=bad','\\documentclass{article}\\begin{document}\\UndefinedQualificationMacro\\end{document}'],{cwd:dir,env,encoding:'utf8'});
 assert.notEqual(bad.status,0);assert.match(bad.stdout,/Undefined control sequence/);
 const mapping=execFileSync('synctex',['view','-i','7:0:main.tex','-o','main.pdf'],{cwd:dir,env,encoding:'utf8'});
 assert.match(mapping,/Page:1/);
 writeFileSync(join(output,label+'.synctex.txt'),mapping);

 const startupMs=[];for(let n=0;n<3;n++){const t=performance.now();const command=label==='native-pdftex'?['/usr/bin/perl',['/usr/local/texlive/2026/texmf-dist/scripts/latexmk/latexmk.pl','-v']]:['latexmk',['-v']];execFileSync(...command,{cwd:dir,env,stdio:'pipe'});startupMs.push(performance.now()-t)}
 if(label==='native'){
   const config='print "QUAL_PERL=$^X\\n";\n';writeFileSync(join(dir,'latexmkrc'),config);
   const fallback=execFileSync('latexmk',['-v'],{cwd:dir,env,encoding:'utf8'});assert.match(fallback,/QUAL_PERL=\/usr\/bin\/perl/);
 }
 results.engines[label]={samples,memoryKiB,pdfHashes,startupMs};
}
assert.deepEqual(results.engines.previous.pdfHashes,results.engines.native.pdfHashes,'Native engine changed PDF bytes');
assert.deepEqual(results.engines.previous.pdfHashes,results.engines['native-pdftex'].pdfHashes);
writeFileSync(output+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
