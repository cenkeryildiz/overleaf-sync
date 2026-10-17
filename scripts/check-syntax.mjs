import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['scripts', 'test']) {
  for (const name of readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
  }
}
console.log('Repository JavaScript syntax checks passed. Application TypeScript is not implemented yet.');
