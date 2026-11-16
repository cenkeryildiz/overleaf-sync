import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const image=process.env.PREVIEW_WORKER_IMAGE;assert(image,'Designate the isolated candidate image');
const child=spawn('docker',['run','--rm','--network','none','--user','www-data','--entrypoint','sh','-i',image,'-c','mkdir /tmp/preview-check && exec /opt/texpresso/bin/overleaf-live-preview /tmp/preview-check'],{stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
const request=async body=>{child.stdin.write(JSON.stringify(body)+'\n');const line=await lines.next();assert(!line.done,'Worker exited before replying');return JSON.parse(line.value)};
try{
 const source='\\documentclass[11pt]{article}\n\\usepackage{bbm}\n\\begin{document}\nFirstPage $x^2+1+\\mathbbm{1}$.\n\\newpage\nSecondPage markerA.\n\\end{document}\n';
 const initial=await request({op:'start',main:'main.tex',active:'main.tex',resources:[{path:'main.tex',content:source}],text:source,line:4,uid:61000});assert(initial.ok,initial.error);assert.equal(initial.frame.page,0);assert(JSON.stringify(initial.frame.text).includes('FirstPage'),JSON.stringify(initial.frame.text));
 if(process.env.PREVIEW_GLYPH_DIR){writeFileSync(process.env.PREVIEW_GLYPH_DIR+'/main.tex',source);writeFileSync(process.env.PREVIEW_GLYPH_DIR+'/live.png',Buffer.from(initial.frame.png,'base64'));}
 const offset=Buffer.byteLength(source.slice(0,source.indexOf('markerA')))+6;
 const updated=await request({op:'edit',base:0,revision:1,offset,remove:1,insert:'B',line:6});assert(updated.ok,updated.error);assert.equal(updated.frame.revision,1);assert.equal(updated.frame.page,1);assert(JSON.stringify(updated.frame.text).includes('markerB'),'Only the page containing the edited marker is accepted');
 const stale=await request({op:'edit',base:0,revision:2,offset,remove:1,insert:'C',line:6});assert.equal(stale.ok,false);assert.equal(stale.error,'stale revision');console.log(JSON.stringify({passed:true,startPage:initial.frame.page,editedPage:updated.frame.page,staleRejected:true}));
}finally{child.stdin.end();child.kill('SIGTERM')}
