import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const client=readFileSync(new URL('../runtime/incremental-preview/client.js',import.meta.url),'utf8');
test('ordinary editor sessions do not activate experimental preview',()=>{
 const original=Object.freeze({});const context={overleafRecovery:original,URLSearchParams,location:{search:''}};vm.runInNewContext(client,context);assert.equal(context.overleafRecovery,original);assert.equal(context.overleafLivePreview,undefined);
});
test('incremental UTF-8 edits preserve complete Unicode characters',()=>{
 const context={overleafRecovery:{},URLSearchParams,location:{search:'?live-preview=1'},TextEncoder,PerformanceObserver:class{observe(){}},addEventListener(){}};vm.runInNewContext(client,context);
 for(const [before,after] of [['abc','abc'],['a😀b','a😄b'],['😀end','🪄end'],['xé','x'],['a','a😀'],['a😀','a']]){
  const edit=context.overleafLivePreview.diff(before,after),bytes=Buffer.from(before);const result=Buffer.concat([bytes.subarray(0,edit.offset),Buffer.from(edit.insert),bytes.subarray(edit.offset+edit.remove)]);assert.equal(result.toString('utf8'),after);
 }
});
test('runtime cache versioning preserves the installed caret version and rejects changed inputs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'preview-assets-'));
 try{
  const input=join(dir,'manifest.json'),output=join(dir,'patched.json'),hash='a'.repeat(64),runtime='/js/runtime-0239170c7f0b0a6c5b25.js',caret='/js/main.js?v=preserved';
  writeFileSync(input,JSON.stringify({'runtime.js':runtime,entrypoints:{ide:{assets:{js:[runtime,caret]}}}}));
  const run=kind=>spawnSync(process.execPath,['runtime/incremental-preview/apply.mjs',kind,input,output,hash],{encoding:'utf8'});
  assert.equal(run('manifest').status,0);const patched=JSON.parse(readFileSync(output));assert.equal(patched['runtime.js'],runtime+'?v='+hash);assert.equal(patched.entrypoints.ide.assets.js[1],caret);
  rmSync(output);assert.notEqual(run('editor').status,0);assert(!existsSync(output));assert.notEqual(run('runtime').status,0);assert(!existsSync(output));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
