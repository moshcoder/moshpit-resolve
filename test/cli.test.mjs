import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONCURRENCY } from "../lib/index.mjs";

const BIN = fileURLToPath(new URL("../bin/moshpit-resolve.mjs", import.meta.url));

function run(args, { stdoutDelayMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (stdoutDelayMs > 0) child.stdout.pause();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (stdoutDelayMs > 0) {
      setTimeout(() => child.stdout.resume(), stdoutDelayMs);
    }
  });
}

test("--json prints the complete machine-readable resolution", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registered: true,
      name_registered: true,
      resolved: "blue.eggs",
      target: "203.0.113.9",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address();
    const result = await run([
      "blue.eggs",
      "--moshpit",
      "--registry", `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      name: "blue.eggs",
      registry: {
        registered: true,
        resolved: "blue.eggs",
        target: "203.0.113.9",
      },
      decision: {
        use: "moshpit",
        reason: "registered in Moshpit",
        resolved: "blue.eggs",
      },
      destination: `http://127.0.0.1:${port}/n/blue.eggs`,
    });
    assert.equal(requests, 1, "the CLI should make one registry request per resolution");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("--console sends namespace-management names to a custom console", async () => {
  const result = await run([
    "--console", "https://console.example/custom/",
    "mosh.eggs",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    name: "mosh.eggs",
    registry: null,
    decision: {
      use: "register",
      reason: "mosh.eggs is the registration console for .eggs",
      url: "https://console.example/custom/pit?tld=eggs",
    },
    destination: "https://console.example/custom/pit?tld=eggs",
  });
});

test("--parking sends unpointed names to a custom parking base", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registered: false,
      name_registered: false,
      resolved: "blue.eggs",
      target: null,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const result = await run([
      "--registry", `http://127.0.0.1:${server.address().port}`,
      "--parking", "https://parking.example/custom/",
      "blue.eggs",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      name: "blue.eggs",
      registry: {
        registered: false,
        resolved: "blue.eggs",
        target: null,
      },
      decision: {
        use: "park",
        reason: "unclaimed Moshpit name — parked",
        url: "https://parking.example/custom/n/blue.eggs",
      },
      destination: "https://parking.example/custom/n/blue.eggs",
    });
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("URL options reject missing values without consuming another option", async () => {
  for (const option of ["registry", "console", "parking"]) {
    const human = await run(["mosh.eggs", `--${option}`]);
    assert.equal(human.status, 1, option);
    assert.equal(human.stdout, "", option);
    assert.equal(human.stderr, `moshpit-resolve: --${option} requires a URL\n`, option);

    const json = await run(["mosh.eggs", `--${option}`, "--json"]);
    assert.equal(json.status, 1, option);
    assert.equal(json.stderr, "", option);
    assert.deepEqual(JSON.parse(json.stdout), {
      name: "mosh.eggs",
      error: `--${option} requires a URL`,
    });
  }
});

test("--json keeps invalid-name errors machine-readable", async () => {
  const result = await run(["localhost", "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    name: "localhost",
    error: "not a Moshpit name (one label and one ending)",
  });
});

test("--timeout rejects invalid values before making a request", async () => {
  for (const value of [undefined, "0", "-1", "1.5", "1e3", "nope"]) {
    const args = ["blue.eggs", "--timeout"];
    if (value !== undefined) args.push(value);
    const result = await run(args);

    assert.equal(result.status, 1, value);
    assert.equal(result.stdout, "", value);
    assert.match(result.stderr, /--timeout must be a positive integer in milliseconds/, value);
  }
});

test("--timeout validation stays machine-readable with --json", async () => {
  const result = await run(["blue.eggs", "--timeout", "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    name: "blue.eggs",
    error: "--timeout must be a positive integer in milliseconds",
  });
});

test("--timeout aborts a slow registry lookup", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name_registered: true, target: "203.0.113.9" }));
    }, 3000);
    timer.unref();
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const started = Date.now();
  const result = await run([
    "blue.eggs",
    "--registry", `http://127.0.0.1:${server.address().port}`,
    "--timeout", "100",
    "--json",
  ]);
  const elapsed = Date.now() - started;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).registry, null);
  assert.equal(requests, 1);
  assert.ok(elapsed < 1500, `configured timeout took ${elapsed}ms`);
});

test("--concurrency rejects invalid values before making a request", async () => {
  for (const value of [undefined, "0", "-1", "1.5", "1e3", "nope"]) {
    const args = ["blue.eggs", "--concurrency"];
    if (value !== undefined) args.push(value);
    const result = await run(args);

    assert.equal(result.status, 1, value);
    assert.equal(result.stdout, "", value);
    assert.match(result.stderr, /--concurrency must be a positive integer/, value);
  }

  const json = await run(["blue.eggs", "--concurrency", "--json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  assert.deepEqual(JSON.parse(json.stdout), {
    name: "blue.eggs",
    error: "--concurrency must be a positive integer",
  });
});

test("batch JSON reports global option errors for every requested name", async () => {
  const cases = [
    [["--registry"], "--registry requires a URL"],
    [["--timeout", "0"], "--timeout must be a positive integer in milliseconds"],
    [["--concurrency", "0"], "--concurrency must be a positive integer"],
  ];

  for (const [options, error] of cases) {
    const result = await run(["first.eggs", "second.eggs", ...options, "--json"]);

    assert.equal(result.status, 1, error);
    assert.equal(result.stderr, "", error);
    assert.deepEqual(JSON.parse(result.stdout), [
      { name: "first.eggs", error },
      { name: "second.eggs", error },
    ]);
  }

  const names = Array.from({ length: 3000 }, (_, index) => `mosh.t${index}`);
  const large = await run(
    [...names, "--concurrency", "0", "--json"],
    { stdoutDelayMs: 100 },
  );
  const output = JSON.parse(large.stdout);

  assert.equal(large.status, 1);
  assert.equal(large.stderr, "");
  assert.equal(output.length, names.length);
  assert.deepEqual(output.map(({ name }) => name), names);
});

test("batch JSON reports each name in input order and exits non-zero for invalid input", async (t) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const name = new URL(request.url, "http://127.0.0.1").searchParams.get("name");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registered: true,
      name_registered: true,
      resolved: name,
      target: `${name}.target`,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await run([
    "first.eggs", "localhost", "second.eggs",
    "--moshpit",
    "--registry", `http://127.0.0.1:${server.address().port}`,
    "--json",
  ]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(output.map(({ name }) => name), [
    "first.eggs", "localhost", "second.eggs",
  ]);
  assert.equal(output[0].decision.use, "moshpit");
  assert.deepEqual(output[1], {
    name: "localhost",
    error: "not a Moshpit name (one label and one ending)",
  });
  assert.equal(output[2].decision.use, "moshpit");
  assert.equal(requests, 2);
});

test("batch human output preserves order and includes invalid names", async () => {
  const result = await run([
    "mosh.eggs", "localhost", "mosh.oranges",
    "--console", "https://console.example",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `mosh.eggs
  registry   unreachable
  decision   register
  reason     mosh.eggs is the registration console for .eggs
  goes to    https://console.example/pit?tld=eggs

localhost — not a Moshpit name (one label and one ending)

mosh.oranges
  registry   unreachable
  decision   register
  reason     mosh.oranges is the registration console for .oranges
  goes to    https://console.example/pit?tld=oranges
`);
});

test("large batch JSON flushes completely before a non-zero exit", async () => {
  const names = Array.from({ length: 300 }, (_, index) => `mosh.t${index}`);
  names.splice(150, 0, "localhost");

  const result = await run([
    ...names, "--console", "https://console.example", "--json",
  ]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(output.length, names.length);
  assert.deepEqual(output.map(({ name }) => name), names);
  assert.deepEqual(output[150], {
    name: "localhost",
    error: "not a Moshpit name (one label and one ending)",
  });
});

test("batch resolution bounds concurrency and coalesces normalized duplicates", async (t) => {
  let active = 0;
  let maxActive = 0;
  const requests = new Map();
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").searchParams.get("name");
    requests.set(name, (requests.get(name) || 0) + 1);
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        registered: true,
        name_registered: true,
        resolved: name,
        target: `${name}.target`,
      }));
      active--;
    }, 40);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const registry = `http://127.0.0.1:${server.address().port}`;
  const names = [
    "one.eggs", "ONE.EGGS.", "two.eggs", "three.eggs",
    "four.eggs", "five.eggs", "six.eggs",
  ];
  const limited = await run([
    ...names, "--moshpit", "--registry", registry, "--concurrency", "2", "--json",
  ]);

  assert.equal(limited.status, 0, limited.stderr || limited.stdout);
  assert.equal(limited.stderr, "");
  assert.ok(maxActive > 1, `expected parallel requests, saw ${maxActive}`);
  assert.ok(maxActive <= 2, `concurrency limit exceeded: ${maxActive}`);
  assert.equal(requests.get("one.eggs"), 1);
  assert.equal([...requests.values()].reduce((sum, count) => sum + count, 0), 6);
  assert.deepEqual(JSON.parse(limited.stdout).map(({ name }) => name), names);

  active = 0;
  maxActive = 0;
  requests.clear();
  const defaultNames = Array.from(
    { length: DEFAULT_CONCURRENCY + 4 },
    (_, index) => `default${index}.eggs`,
  );
  const defaults = await run([
    ...defaultNames, "--moshpit", "--registry", registry, "--json",
  ]);

  assert.equal(defaults.status, 0, defaults.stderr || defaults.stdout);
  assert.equal(DEFAULT_CONCURRENCY, 8);
  assert.ok(maxActive > 1, `expected parallel requests, saw ${maxActive}`);
  assert.ok(
    maxActive <= DEFAULT_CONCURRENCY,
    `default concurrency limit exceeded: ${maxActive}`,
  );
  assert.deepEqual(JSON.parse(defaults.stdout).map(({ name }) => name), defaultNames);
});
