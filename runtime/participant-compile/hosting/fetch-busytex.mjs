// SPDX-License-Identifier: AGPL-3.0-only
// Build only, in a cached stage: download the pinned BusyTeX1.4.1 SDK and assets once; integration edits never refetch them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const out = '/busytex', participant = out + '/participant';
async function download(url, destination, algorithm, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) }); assert(response.ok, 'Public asset unavailable');
  const hash = createHash(algorithm);
  await pipeline(response.body, new Transform({ transform(chunk, _, next) { hash.update(chunk); next(null, chunk); } }), createWriteStream(destination, { flags: 'wx' }));
  assert.equal(hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'), expected, 'Public asset integrity mismatch');
}
mkdirSync(participant, { recursive: true });
await download('https://registry.npmjs.org/texlyre-busytex/-/texlyre-busytex-1.4.1.tgz', '/tmp/busytex-sdk.tgz', 'sha512',
  '7PswiiuCIYc0HGK/HyQz0At/6Pc9pMk7Qy+DkzHk+BGVInWetXaeZq2px7V06pHscJG215YOU6as/0sgRmulNA==');
mkdirSync('/tmp/busytex-sdk'); execFileSync('tar', ['-xzf', '/tmp/busytex-sdk.tgz', '--no-same-owner', '-C', '/tmp/busytex-sdk', '--strip-components=1']);
// The unpatched SDK stays in this stage; the next stage step writes the patched module.
writeFileSync(out + '/sdk-index.js', readFileSync('/tmp/busytex-sdk/dist/index.js'));
copyFileSync('/tmp/busytex-sdk/LICENSE', participant + '/BUSYTEX-LICENSE');
await download('https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v1.4.1/busytex-assets.tar.gz', '/tmp/busytex-assets.tar.gz', 'sha256',
  '4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b');
execFileSync('tar', ['-xzf', '/tmp/busytex-assets.tar.gz', '--no-same-owner', '-C', participant]);
console.log('Fetched pinned BusyTeX SDK and assets.');
