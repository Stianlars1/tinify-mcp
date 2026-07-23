// Stdio smoke test: spawns the built server with a fake key, performs the
// MCP initialize handshake, lists tools, and asserts the expected names.
// Also asserts the fail-fast behavior when TINIFY_API_KEY is unset.
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");

const EXPECTED_TOOLS = [
  "compress_image",
  "resize_image",
  "crop_image",
  "convert_image",
  "get_usage",
];

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

// --- 1. Fail-fast without a key -------------------------------------------
{
  const env = { ...process.env };
  delete env.TINIFY_API_KEY;
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  if (code !== 1) fail(`expected exit code 1 without TINIFY_API_KEY, got ${code}`);
  if (!stderr.includes("TINIFY_API_KEY is not set")) {
    fail(`missing-key stderr not readable:\n${stderr}`);
  }
  console.log("ok: exits 1 with a readable message when TINIFY_API_KEY is unset");
}

// --- 2. initialize + tools/list over stdio ---------------------------------
{
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, TINIFY_API_KEY: "tnf_test_smoke_key" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => {
    child.kill();
    fail("timed out waiting for tools/list response");
  }, 10_000);

  let buffer = "";
  const responses = new Map();
  const waiters = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        responses.set(message.id, message);
        waiters.get(message.id)?.(message);
      }
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) =>
    responses.has(id)
      ? Promise.resolve(responses.get(id))
      : new Promise((resolve) => waiters.set(id, resolve));

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
  });
  const init = await waitFor(1);
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
  const serverName = init.result?.serverInfo?.name;
  if (serverName !== "tinify") fail(`unexpected server name: ${serverName}`);
  console.log(
    `ok: initialize → server "${serverName}" v${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`,
  );

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitFor(2);
  if (list.error) fail(`tools/list failed: ${JSON.stringify(list.error)}`);
  const names = list.result.tools.map((tool) => tool.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`tool names mismatch: ${names.join(", ")}`);
  }
  console.log(`ok: tools/list → ${list.result.tools.map((tool) => tool.name).join(", ")}`);

  clearTimeout(timeout);
  child.kill();
  console.log("SMOKE PASS");
}
