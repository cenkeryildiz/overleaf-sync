import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {promisify} from 'node:util';
import Path from 'node:path';
async function runner(){
 const child=new EventEmitter();Object.assign(child,{pid:4321,stdout:new EventEmitter(),stderr:new EventEmitter()});child.stdout.setEncoding=child.stderr.setEncoding=function(){return this};
 const kills=[],deadlines=[],spawns=[];const context=vm.createContext({Buffer,setTimeout:(fn,ms)=>{deadlines.push({fn,ms});return 1},clearTimeout(){},process:{env:{APP_SECRET:'must be stripped by launcher'},kill:(...args)=>kills.push(args)}});
 const imports={'node:child_process':{spawn:(...args)=>{spawns.push(args);return child}},'node:util':{promisify},'node:path':{default:Path},lodash:{default:{once:fn=>{let called=false;return(...args)=>{if(!called){called=true;return fn(...args)}}}}},'@overleaf/logger':{default:{debug(){},warn(){},err(){}}}};
 const mod=new vm.SourceTextModule(readFileSync(new URL('../runtime/compile-sandbox/LocalCommandRunner.js',import.meta.url),'utf8'),{context});
 await mod.link(spec=>{const values=imports[spec];assert(values,spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v)},{context})});await mod.evaluate();return {runner:mod.namespace.default,child,kills,deadlines,spawns};
}
test('worker signal cannot become a successful compile result',async()=>{const t=await runner();let error,result;t.runner.run('project',['latexmk','$COMPILE_DIR/main.tex'],'/jobs/project',null,1000,{},'standard',null,(e,r)=>{error=e;result=r});assert.equal(t.spawns[0][0],'/opt/overleaf-native-tex/bin/overleaf-compile-sandbox');t.child.emit('exit',null,'SIGKILL');t.child.emit('close',null,'SIGKILL');assert.equal(error.terminated,true);assert.equal(result,undefined);assert.equal(t.kills[0][0],-4321);});
test('wall deadline and output overflow stop owned process groups',async()=>{for(const type of ['deadline','output']){const t=await runner();let error;t.runner.run('project',['latexmk'],'/jobs/project',null,500,{},'standard',null,e=>{error=e});assert.equal(t.deadlines[0].ms,500);if(type==='deadline')t.deadlines[0].fn();else t.child.stdout.emit('data','x'.repeat(8*1024*1024+1));assert.deepEqual(t.kills[0],[-4321,'SIGKILL']);t.child.emit('close',null,'SIGKILL');assert.equal(error.terminated,true);assert.equal(error.timedout,type==='deadline');}});
test('invalid deadlines fail before creating a process',async()=>{const t=await runner();let error;t.runner.run('project',['latexmk'],'/jobs/project',null,Infinity,{},'standard',null,e=>{error=e});assert(error);assert.equal(t.spawns.length,0);});
