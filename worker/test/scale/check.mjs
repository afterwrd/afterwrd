// Checks that every measuring line the other machines made reached the first machine's stats.log (start.mjs sends
// them there), as the scenarios and the report count from it:
//   node test/scale/check.mjs <first machine's stats.log> <another machine's stats.log> …
// A site's lines are only ever made on the machine that runs it, so it's enough that, for each of another machine's
// sites, the first has at least as many lines as that machine made (each read a line at a time: a big network's are
// gigabytes).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const [first, ...others] = process.argv.slice(2);

/** How many lines each site has in the log at `path`. */
async function perSite(path) {
  const counts = new Map();
  let lines = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line) continue;
    lines++;
    const site = /"site":"([^"]*)"/.exec(line)?.[1] ?? "?";
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return { counts, lines };
}

const there = await perSite(first);
let missing = 0;
for (const path of others) {
  const { counts, lines } = await perSite(path);
  let short = 0;
  for (const [site, n] of counts) short += Math.max(0, n - (there.counts.get(site) ?? 0));
  console.log(`${path}: ${lines} measuring lines for ${counts.size} sites; ${short ? `${short} missing from` : "all in"} ${first}`);
  missing += short;
}
if (missing) {
  console.error(`${missing} measuring lines didn't reach the first machine.`);
  process.exit(1);
}
console.log(`All there (${there.lines} lines in all).`);
