// The resolution policy: which namespace answers, and where a tab ends up.
//
// This suite replaces a "faithfulness" one that ran two hand-synced copies of
// these rules over the same inputs and required identical answers. There is one
// copy now, so the tests can be about the behaviour instead of about the drift.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  consoleUrlFor, decideResolution, destinationFor, gatewayUrlFor,
  moshpitBypassHosts, parkingUrlFor, parseRegistryName, resolutionFor,
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

test("resolutionFor explains a navigation with one registry lookup", async (t) => {
  const requests = [];
  const answers = {
    "live.eggs": { name_registered: true, resolved: "live.eggs", target: "203.0.113.9" },
    "parked.eggs": { name_registered: true, resolved: "parked.eggs", target: null },
    "open.eggs": { name_registered: false, resolved: "open.eggs", target: null },
  };
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").searchParams.get("name");
    requests.push(name);
    if (!answers[name]) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answers[name]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const registryBase = `http://127.0.0.1:${server.address().port}`;

    await t.test("a live name includes the answer, decision and destination", async () => {
      const result = await resolutionFor(" LIVE.EGGS. ", false, { registryBase });
      assert.deepEqual(result, {
        registry: { registered: true, resolved: "live.eggs", target: "203.0.113.9" },
        decision: {
          use: "moshpit",
          reason: "clearnet has no answer — resolved through Moshpit",
          resolved: "live.eggs",
        },
        destination: `${registryBase}/n/live.eggs`,
      });
      assert.deepEqual(requests, ["live.eggs"], "the trace must not repeat the registry lookup");
    });

    await t.test("parked and unclaimed names keep their distinct reasons", async () => {
      const config = { registryBase, parkingBase: "https://parking.example/base/" };
      const parkedResult = await resolutionFor("parked.eggs", false, config);
      const openResult = await resolutionFor("open.eggs", false, config);

      assert.equal(parkedResult.registry.registered, true);
      assert.equal(parkedResult.decision.use, "park");
      assert.match(parkedResult.decision.reason, /not pointed/);
      assert.equal(parkedResult.destination, "https://parking.example/base/n/parked.eggs");

      assert.equal(openResult.registry.registered, false);
      assert.equal(openResult.decision.use, "park");
      assert.match(openResult.decision.reason, /unclaimed/);
      assert.equal(openResult.destination, "https://parking.example/base/n/open.eggs");
      assert.deepEqual(requests, ["live.eggs", "parked.eggs", "open.eggs"]);
    });

    await t.test("invalid names and the console label skip the registry", async () => {
      const before = requests.length;
      assert.deepEqual(await resolutionFor("a.b.c", false, { registryBase }), {
        registry: null,
        decision: { use: "clearnet", reason: "not a Moshpit name" },
        destination: null,
      });

      assert.deepEqual(await resolutionFor("mosh.eggs", false, {
        registryBase,
        consoleBase: "https://console.example/",
      }), {
        registry: null,
        decision: {
          use: "register",
          reason: "mosh.eggs is the registration console for .eggs",
          url: "https://console.example/pit?tld=eggs",
        },
        destination: "https://console.example/pit?tld=eggs",
      });
      assert.equal(requests.length, before);
    });

    await t.test("an unavailable registry still returns a complete trace", async () => {
      assert.deepEqual(await resolutionFor("down.eggs", false, { registryBase }), {
        registry: null,
        decision: { use: "clearnet", reason: "Moshpit registry not consulted or unreachable" },
        destination: null,
      });
      assert.equal(requests.at(-1), "down.eggs");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
