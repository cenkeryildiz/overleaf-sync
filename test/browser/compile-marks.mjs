// SPDX-License-Identifier: AGPL-3.0-only
// OPT-01: one timeline of page marks, compiler-worker marks, compiler asset and output PDF fetches, in ms from `origin` (epoch ms).
export async function compileTimeline(page, worker, origin) {
  const collect = () => [...performance.getEntriesByType('mark').map(e => ({ at: performance.timeOrigin + e.startTime, name: e.name })),
    ...performance.getEntriesByType('resource').filter(e => /\/busytex\/|\/output\/output\.pdf/.test(e.name)).map(e => ({ at: performance.timeOrigin + e.startTime,
      name: 'fetch ' + new URL(e.name).pathname.split('/').pop(), ms: Math.round(e.responseEnd - e.startTime), bytes: e.transferSize || e.encodedBodySize }))];
  const entries = [...await page.evaluate(collect), ...(worker ? await worker.evaluate(collect) : [])];
  return entries.sort((a, b) => a.at - b.at).map(({ at, ...rest }) => ({ t: Math.round(at - origin), ...rest }));
}
export const now = page => page.evaluate(() => performance.timeOrigin + performance.now());
