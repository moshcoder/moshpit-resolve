// The resolution policy: which namespace answers, and where a tab ends up.
//
// This suite replaces a "faithfulness" one that ran two hand-synced copies of
// these rules over the same inputs and required identical answers. There is one
// copy now, so the tests can be about the behaviour instead of about the drift.
import assert from "node:assert/strict";
import test from "node:test";

import {
  consoleUrlFor, decideResolution, destinationFor, gatewayUrlFor,
  moshpitBypassHosts, parkingUrlFor, parseRegistryName,
} from "../lib/index.mjs";

const live = { registered: true, name_registered: true, resolved: "blue.eggs", target: "203.0.113.9" };
const parked = { registered: true, name_registered: true, resolved: "blue.eggs", target: null };
const unclaimed = { registered: true, name_registered: false, resolved: "blue.eggs", target: null };

test("a name is one label and one ending", () => {
  assert.deepEqual(parseRegistryName("blue.eggs"), { label: "blue", tld: "eggs" });
  for (const bad of ["a.b.c", "localhost", "1.2.3.4", "", "eggs"]) {
    assert.equal(parseRegistryName(bad), null, bad);
  }
});

test("clearnet wins by default, and Moshpit fills the gap", () => {
  // The default mode must never take a name away from the real internet.
  const answered = decideResolution({
    hostname: "blue.eggs", mode: "clearnet", clearnetResolves: true, moshpit: live,
  });
  assert.notEqual(answered.use, "moshpit");

  const empty = decideResolution({
    hostname: "blue.eggs", mode: "clearnet", clearnetResolves: false, moshpit: live,
  });
  assert.equal(empty.use, "moshpit");
  assert.equal(empty.resolved, "blue.eggs");
});

test("moshpit mode lets a registered name beat a clearnet answer", () => {
  const d = decideResolution({
    hostname: "blue.eggs", mode: "moshpit", clearnetResolves: true, moshpit: live,
  });
  assert.equal(d.use, "moshpit");
});

test("an unreachable registry degrades to clearnet, never to a guess", () => {
  // A registry that is slow or down must not take a name away from the browser;
  // the failure has to be invisible rather than wrong.
  const d = decideResolution({
    hostname: "blue.eggs", mode: "clearnet", clearnetResolves: false, moshpit: null,
  });
  assert.notEqual(d.use, "moshpit");
  assert.match(d.reason, /unreachable|not consulted|not registered/i);
});

test("a claimed name with nowhere to point parks instead of dead-ending", () => {
  const d = decideResolution({
    hostname: "blue.eggs", mode: "clearnet", clearnetResolves: false, moshpit: parked,
  });
  assert.equal(d.use, "park");
  assert.equal(d.url, parkingUrlFor("blue.eggs"));
});

test("an unclaimed name is an invitation, not an error", () => {
  const d = decideResolution({
    hostname: "blue.eggs", mode: "clearnet", clearnetResolves: false, moshpit: unclaimed,
  });
  assert.ok(["park", "register"].includes(d.use), d.use);
});

test("parking and the gateway are the same route", () => {
  // /n/<name> serves a pointed name and shows a directory for an unpointed one
  // — the same question with two answers.
  assert.equal(parkingUrlFor("blue.eggs"), gatewayUrlFor("blue.eggs"));
  assert.equal(gatewayUrlFor("blue.eggs"), "https://pit.moshcode.sh/n/blue.eggs");
});

test("the console label skips the registry entirely", () => {
  // `mosh.<ending>` is reserved, so no lookup can change the answer.
  assert.equal(consoleUrlFor("mosh.eggs"), "https://app.moshcode.sh/pit?tld=eggs");
  assert.equal(consoleUrlFor("blue.eggs"), null);
});

test("a self-hosted pit is followed everywhere", () => {
  assert.equal(gatewayUrlFor("a.eggs", "https://my.pit/"), "https://my.pit/n/a.eggs");
  assert.equal(parkingUrlFor("a.eggs", "https://my.pit/"), "https://my.pit/n/a.eggs");
  assert.deepEqual(moshpitBypassHosts({ registryBase: "https://my.pit:8443" }), ["my.pit"]);
});

test("no destination for something outside the namespace", async () => {
  assert.equal(await destinationFor("example.com", true), null);
  assert.equal(await destinationFor("a.b.c", false), null);
});

test("config is supplied, not discovered", async () => {
  // A library that reached for chrome.storage would only work in a browser
  // extension; this one is handed its config and works anywhere.
  const url = await destinationFor("mosh.eggs", false, { consoleBase: "https://my.console" });
  assert.equal(url, "https://my.console/pit?tld=eggs");
});
