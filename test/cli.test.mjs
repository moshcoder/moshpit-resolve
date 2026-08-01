import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/moshpit-resolve.mjs", import.meta.url));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
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
