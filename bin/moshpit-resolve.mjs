#!/usr/bin/env node
// Ask the resolver what it would do, without a browser.
//
// The same decision the extension makes on every navigation, printed with its
// reason — which is the part you need when a name goes somewhere unexpected.

import {
  DEFAULT_CONCURRENCY, DEFAULT_LOOKUP_TIMEOUT_MS, parseRegistryName, resolutionFor,
} from "../lib/index.mjs";

const USAGE = `moshpit-resolve — where a Moshpit name would send you

  moshpit-resolve [<name...>] [--stdin] [--moshpit] [--clearnet-resolves] [--registry URL] [--console URL] [--parking URL] [--timeout MS] [--concurrency N] [--strict] [--json | --ndjson]

  --moshpit             let a registered name beat a clearnet answer
  --clearnet-resolves   pretend the real internet has an answer for this name
  --registry URL        a self-hosted pit
  --console URL         a custom namespace management console
  --parking URL         a custom base for unpointed names
  --timeout MS          registry request deadline (default: ${DEFAULT_LOOKUP_TIMEOUT_MS})
  --concurrency N       maximum simultaneous batch lookups (default: ${DEFAULT_CONCURRENCY})
  --strict              fail when any registry lookup is inconclusive
  --stdin               append whitespace-delimited names from standard input
  --json                print a machine-readable resolution decision
  --ndjson              print one compact JSON decision per line

Prints the destination and the reason for it. No browser, no navigation.`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const valueFlags = new Set([
  "--registry", "--console", "--parking", "--timeout", "--concurrency",
]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
const names = [...positional];
let name = names[0];
if (flag("help")) { console.log(USAGE); process.exit(name ? 0 : 1); }
if (!name && !flag("stdin")) { console.log(USAGE); process.exit(1); }

const value = (n, d) => {
  const i = args.indexOf(`--${n}`);
  const candidate = i >= 0 ? args[i + 1] : null;
  return candidate && !candidate.startsWith("-") ? candidate : d;
};
const ndjson = flag("ndjson");
const raw = flag("json") || ndjson;
const timeoutValue = value("timeout", null);
const concurrencyValue = value("concurrency", null);
const jsonError = (error) => {
  if (names.length === 0) return { error };
  if (names.length === 1) return { name, error };
  return names.map((requestedName) => ({ name: requestedName, error }));
};
const machineText = (value, space) => {
  if (ndjson) {
    const records = Array.isArray(value) ? value : [value];
    return records.map((record) => JSON.stringify(record)).join("\n");
  }
  return JSON.stringify(value, null, space);
};
const printMachine = (value) => {
  const output = machineText(value, 2);
  if (output) console.log(output);
};
const printJsonError = (error) => new Promise((resolve, reject) => {
  const output = `${machineText(jsonError(error), names.length > 1 ? 2 : undefined)}\n`;
  process.stdout.write(output, (writeError) => {
    if (writeError) reject(writeError);
    else resolve();
  });
});

if (flag("json") && ndjson) {
  await printJsonError("--json and --ndjson cannot be used together");
  process.exit(1);
}

for (const option of ["registry", "console", "parking"]) {
  if (flag(option) && value(option, null) === null) {
    const error = `--${option} requires a URL`;
    if (raw) await printJsonError(error);
    else console.error(`moshpit-resolve: ${error}`);
    process.exit(1);
  }
}

if (args.includes("--timeout") && (
  !/^\d+$/.test(String(timeoutValue ?? ""))
  || !Number.isSafeInteger(Number(timeoutValue))
  || Number(timeoutValue) < 1
)) {
  const error = "--timeout must be a positive integer in milliseconds";
  if (raw) await printJsonError(error);
  else console.error(`moshpit-resolve: ${error}`);
  process.exit(1);
}

if (args.includes("--concurrency") && (
  !/^\d+$/.test(String(concurrencyValue ?? ""))
  || !Number.isSafeInteger(Number(concurrencyValue))
  || Number(concurrencyValue) < 1
)) {
  const error = "--concurrency must be a positive integer";
  if (raw) await printJsonError(error);
  else console.error(`moshpit-resolve: ${error}`);
  process.exit(1);
}

if (flag("stdin")) {
  try {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    names.push(...input.split(/\s+/u).filter(Boolean));
    name = names[0];
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = `failed to read standard input: ${detail}`;
    if (raw) await printJsonError(error);
    else console.error(`moshpit-resolve: ${error}`);
    process.exit(1);
  }
}

const config = {
  mode: flag("moshpit") ? "moshpit" : "clearnet",
  registryBase: value("registry", undefined),
  consoleBase: value("console", undefined),
  parkingBase: value("parking", undefined),
  timeoutMs: timeoutValue === null ? DEFAULT_LOOKUP_TIMEOUT_MS : Number(timeoutValue),
};

const resolutions = new Map();

async function resolveOne(requestedName) {
  const parsed = parseRegistryName(requestedName);
  if (!parsed) {
    return {
      name: requestedName,
      error: "not a Moshpit name (one label and one ending)",
    };
  }

  const normalized = `${parsed.label}.${parsed.tld}`;
  let resolution = resolutions.get(normalized);
  if (!resolution) {
    resolution = resolutionFor(normalized, flag("clearnet-resolves"), config);
    resolutions.set(normalized, resolution);
  }

  const {
    registry, decision, destination,
  } = await resolution;
  return { name: requestedName, registry, decision, destination };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

function printHuman(result) {
  if (result.error) {
    console.log(`${result.name} — ${result.error}`);
    return;
  }

  console.log(`${result.name}`);
  console.log(`  registry   ${result.registry ? JSON.stringify(result.registry) : "unreachable"}`);
  console.log(`  decision   ${result.decision.use}`);
  console.log(`  reason     ${result.decision.reason}`);
  console.log(`  goes to    ${result.destination ?? "(nowhere — the browser keeps its own answer)"}`);
}

const concurrency = concurrencyValue === null
  ? DEFAULT_CONCURRENCY
  : Number(concurrencyValue);
const results = await mapWithConcurrency(names, concurrency, resolveOne);
const strictFailure = (result) => (
  flag("strict")
  && !result.error
  && result.decision.reason === "Moshpit registry not consulted or unreachable"
);

if (names.length === 1) {
  const result = results[0];
  if (result.error) {
    console.log(raw ? JSON.stringify(result) : `${result.name} — ${result.error}`);
    process.exit(1);
  }

  if (raw) printMachine(result);
  else printHuman(result);
  if (strictFailure(result)) process.exitCode = 1;
} else {
  if (raw) {
    printMachine(results);
  } else {
    results.forEach((result, index) => {
      if (index > 0) console.log("");
      printHuman(result);
    });
  }

  if (results.some((result) => result.error || strictFailure(result))) {
    process.exitCode = 1;
  }
}
