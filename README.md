# @moshcoder/moshpit-resolve

The Moshpit resolution policy: which namespace answers a name, and where a
navigation ends up.

```sh
npm i @moshcoder/moshpit-resolve
```

```js
import { destinationFor, decideResolution } from "@moshcoder/moshpit-resolve";

await destinationFor("blue.eggs", /* clearnetResolves */ false);
// → https://pit.moshcode.sh/n/blue.eggs
```

Applications that also need to explain the navigation can get the registry
answer, policy decision and destination together. This performs at most one
registry lookup:

```js
import { resolutionFor } from "@moshcoder/moshpit-resolve";

const resolution = await resolutionFor(hostname, dnsAnswered, settings);

status.textContent = resolution.decision.reason;
if (resolution.destination) navigate(resolution.destination);
```

`resolutionFor` always returns `{ registry, decision, destination }`. Invalid
names and unavailable registries still produce a complete trace with a
clearnet decision and a null destination, so an app does not need a separate
error shape for those cases.

## Why it is a package

These rules lived twice in TronBrowser: a TypeScript module, and a hand port of
it into the extension because the extension is plain JS with no build step. A
test ran both over the same inputs and required identical answers — a suite
whose entire job was catching drift between two copies of one decision.

## What it decides

**Clearnet wins by default.** In `clearnet` mode the real internet keeps every
name it can answer, and Moshpit fills the gaps. In `moshpit` mode a registered
name beats a clearnet answer. Which applies is the resolver operator's call.

**An unreachable registry degrades to clearnet.** A registry that is slow or
down must not take a name away from the browser — the failure has to be
invisible rather than wrong.

**A claimed name with nowhere to point parks** rather than dead-ending on a DNS
error, and an unclaimed one is an invitation to take it.

**Parking and the gateway are the same route.** `/n/<name>` serves a pointed
name and shows a directory for an unpointed one — the same question with two
answers.

## Config is supplied, not discovered

`destinationFor(hostname, clearnetResolves, config)` takes its config. Where
that config lives is the caller's problem — `chrome.storage` in an extension, a
file on a server, a literal in a test. A library that reached for one of those
would only work in one of those places.

## CLI

```sh
moshpit-resolve <name> [--moshpit] [--clearnet-resolves] [--registry URL] [--timeout MS] [--json]
```

```
$ moshpit-resolve california.oranges
california.oranges
  registry   {"registered":true,"resolved":"california.oranges","target":null}
  decision   park
  reason     registered in Moshpit but not pointed at an address yet
  goes to    https://pit.moshcode.sh/n/california.oranges
```

The reason line is the point: it is the same decision the browser makes on
every navigation, and the thing you need when a name goes somewhere unexpected.

Use `--json` when another tool needs the registry answer, decision, reason, and
destination without parsing the human-readable summary.

Registry lookups use an eight-second deadline by default. Scripts and
self-hosted deployments can lower it without changing the resolution policy:

```sh
moshpit-resolve blue.eggs --registry http://127.0.0.1:8787 --timeout 1500
```

## License

MIT.
