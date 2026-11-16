// SPDX-License-Identifier: AGPL-3.0-only
// The trusted worker owns these job containers; a restart must stop orphaned old jobs first.
import Docker from 'dockerode';
const docker=new Docker();
const containers=await docker.listContainers({all:true,filters:{label:['com.cenker.overleaf.worker=ws1']}});
for(const info of containers){const container=docker.getContainer(info.Id);await container.remove({force:true}).catch(error=>{if(error.statusCode!==404)throw error});}
process.execve(process.execPath,[process.execPath,'/overleaf/services/clsi/app.js'],process.env);
