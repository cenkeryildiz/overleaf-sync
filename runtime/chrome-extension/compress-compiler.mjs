// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const compilerAssets = ['biber.data', 'busytex.wasm', 'biber.wasm'];
export async function compressCompilerAssets(directory) {
  assert(directory, 'Provide the compiler asset directory');
  let originalBytes = 0, compressedBytes = 0;
  for (const name of compilerAssets) {
    const source = join(directory, name), target = source + '.gz', temporary = target + '.' + randomUUID() + '.tmp';
    assert((await lstat(source)).isFile(), 'Compiler assets must be regular files');
    assert(!(await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; })), 'Compressed output already exists');
    const original = createHash('sha256'), decoded = createHash('sha256');
    // A streaming roundtrip verifies integrity before removing the original, without holding the bundle in memory.
    try {
      await pipeline(createReadStream(source), new Transform({ transform(chunk, encoding, done) {
        original.update(chunk); originalBytes += chunk.length; done(null, chunk);
      } }), createGzip(), createWriteStream(temporary, { flags: 'wx' }));
      await pipeline(createReadStream(temporary), createGunzip(), decoded);
      assert.equal(decoded.digest('hex'), original.digest('hex'), 'Compressed compiler asset failed readback');
      compressedBytes += (await lstat(temporary)).size;
      await rename(temporary, target);
      await unlink(source);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { originalBytes, compressedBytes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await compressCompilerAssets(process.argv[2])));
