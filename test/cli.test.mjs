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
  const server = createServer((_request, response) => {
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
