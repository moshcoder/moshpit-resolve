#!/usr/bin/env node
// Ask the resolver what it would do, without a browser.
//
// The same decision the extension makes on every navigation, printed with its
// reason — which is the part you need when a name goes somewhere unexpected.

import { destinationFor, decideResolution, lookupMoshpit, parseRegistryName } from "../lib/index.mjs";

const USAGE = `moshpit-resolve — where a Moshpit name would send you

  moshpit-resolve <name> [--moshpit] [--clearnet-resolves] [--registry URL]

  --moshpit             let a registered name beat a clearnet answer
  --clearnet-resolves   pretend the real internet has an answer for this name
  --registry URL        a self-hosted pit

Prints the destination and the reason for it. No browser, no navigation.`;

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
if (!name || args.includes("--help")) { console.log(USAGE); process.exit(name ? 0 : 1); }

const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (!parseRegistryName(name)) {
  console.log(`${name} — not a Moshpit name (one label and one ending)`);
  process.exit(1);
}

const config = { mode: flag("moshpit") ? "moshpit" : "clearnet", registryBase: value("registry", undefined) };
const moshpit = await lookupMoshpit(name, { registryBase: config.registryBase });
const decision = decideResolution({
  hostname: name, mode: config.mode, clearnetResolves: flag("clearnet-resolves"), moshpit,
});

console.log(`${name}`);
console.log(`  registry   ${moshpit ? JSON.stringify(moshpit) : "unreachable"}`);
console.log(`  decision   ${decision.use}`);
console.log(`  reason     ${decision.reason}`);
const url = await destinationFor(name, flag("clearnet-resolves"), config);
console.log(`  goes to    ${url ?? "(nowhere — the browser keeps its own answer)"}`);
