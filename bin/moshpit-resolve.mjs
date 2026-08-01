#!/usr/bin/env node
// Ask the resolver what it would do, without a browser.
//
// The same decision the extension makes on every navigation, printed with its
// reason — which is the part you need when a name goes somewhere unexpected.

import {
  DEFAULT_LOOKUP_TIMEOUT_MS, parseRegistryName, resolutionFor,
} from "../lib/index.mjs";

const USAGE = `moshpit-resolve — where a Moshpit name would send you

  moshpit-resolve <name> [--moshpit] [--clearnet-resolves] [--registry URL] [--timeout MS]

  --moshpit             let a registered name beat a clearnet answer
  --clearnet-resolves   pretend the real internet has an answer for this name
  --registry URL        a self-hosted pit
  --timeout MS          registry request deadline (default: ${DEFAULT_LOOKUP_TIMEOUT_MS})
  --json                print a machine-readable resolution decision

Prints the destination and the reason for it. No browser, no navigation.`;

const args = process.argv.slice(2);
const valueFlags = new Set(["--registry", "--timeout"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
const name = positional[0];
if (!name || args.includes("--help")) { console.log(USAGE); process.exit(name ? 0 : 1); }

const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const raw = flag("json");
const timeoutValue = value("timeout", null);

if (args.includes("--timeout") && (
  !/^\d+$/.test(String(timeoutValue ?? ""))
  || !Number.isSafeInteger(Number(timeoutValue))
  || Number(timeoutValue) < 1
)) {
  const error = "--timeout must be a positive integer in milliseconds";
  if (raw) console.log(JSON.stringify({ name, error }));
  else console.error(`moshpit-resolve: ${error}`);
  process.exit(1);
}

if (!parseRegistryName(name)) {
  const error = "not a Moshpit name (one label and one ending)";
  console.log(raw ? JSON.stringify({ name, error }) : `${name} — ${error}`);
  process.exit(1);
}

const config = {
  mode: flag("moshpit") ? "moshpit" : "clearnet",
  registryBase: value("registry", undefined),
  timeoutMs: timeoutValue === null ? DEFAULT_LOOKUP_TIMEOUT_MS : Number(timeoutValue),
};
const {
  registry: moshpit, decision, destination: url,
} = await resolutionFor(name, flag("clearnet-resolves"), config);

if (raw) {
  console.log(JSON.stringify({ name, registry: moshpit, decision, destination: url }, null, 2));
} else {
  console.log(`${name}`);
  console.log(`  registry   ${moshpit ? JSON.stringify(moshpit) : "unreachable"}`);
  console.log(`  decision   ${decision.use}`);
  console.log(`  reason     ${decision.reason}`);
  console.log(`  goes to    ${url ?? "(nowhere — the browser keeps its own answer)"}`);
}
