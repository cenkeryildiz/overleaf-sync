// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [kind,input,output]=process.argv.slice(2),identities={compile:['51632668637d4eef9c36912edfb160790bb9deb37ca963613656522066dc00eb',2],conversion:['dd640a097bfe6c670e3d7d9a15ba3533f83a873b5fb6264ea87404d3bb9cdcee',3],docker:['cf941264bc358f06c33dda923fb0925ef2120c93c29eb0ae92c82da9994477c5',1]};
assert(identities[kind]&&input&&output&&input!==output,'Select a pinned caller and separate output');
let source=readFileSync(input,'utf8'),[hash,count]=identities[kind];
assert.equal(createHash('sha256').update(source).digest('hex'),hash,'Pinned CLSI caller changed');
const anchor=kind==='docker'?'    return options':'const lock = LockManager.acquire(';
assert.equal(source.split(anchor).length-1,count,'Lock callers changed');
if(kind==='compile') {
 const before='    const { outputFiles, allEntries, buildId } = await _saveOutputFiles({';
 assert.equal(source.split(before).length-1,1,'Interrupted-output anchor changed');
 source=source.replace(before,"    if (error.terminated || error.timedout) {\n      await fsPromises.rm(Path.join(compileDir, 'output.pdf'), { force: true })\n      await fsPromises.rm(Path.join(compileDir, 'output.synctex.gz'), { force: true })\n    }\n\n"+before);
 const interrupted="      await clearProjectWithListing(\n        request.project_id,\n        request.user_id,\n        allEntries\n      )";
 assert.equal(source.split(interrupted).length-1,1,'Interrupted cleanup anchor changed');
 source=source.replace(interrupted,'      await clearProject(request.project_id, request.user_id)');
}
writeFileSync(output,source.replaceAll(anchor,kind==='docker'?"    const limits = Settings.clsi.docker.compileGroupConfig?.standard\n    if (!limits) throw new Error('Compile isolation limits are not configured')\n    for (const [key, value] of Object.entries(limits)) _.set(options, key, value)\n    return options":'const lock = await LockManager.acquire('),{flag:'wx'});
