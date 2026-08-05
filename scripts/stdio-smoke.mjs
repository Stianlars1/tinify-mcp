// Stdio smoke test: verifies the MCP handshake and tool list both with and
// without a configured key. The unconfigured server must stay alive and return
// the setup instruction in-band from a tool call.
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

function startSession(env) {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
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
        const resolve = waiters.get(message.id);
        if (resolve !== undefined) {
          waiters.delete(message.id);
          resolve(message);
        }
      }
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id, label) => {
    const response = responses.has(id)
      ? Promise.resolve(responses.get(id))
      : new Promise((resolve) => waiters.set(id, resolve));
    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        10_000,
      ).unref();
    });
    return Promise.race([response, timeout]);
  };
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  };
  return {
    child,
    send,
    waitFor,
    stop,
    getStderr: () => stderr,
  };
}

async function initialize(session, id) {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
  });
  const init = await session.waitFor(id, "initialize");
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
  const serverName = init.result?.serverInfo?.name;
  if (serverName !== "tinify") fail(`unexpected server name: ${serverName}`);
  console.log(
    `ok: initialize → server "${serverName}" v${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`,
  );
  session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

async function assertToolList(session, id) {
  session.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
  const list = await session.waitFor(id, "tools/list");
  if (list.error) fail(`tools/list failed: ${JSON.stringify(list.error)}`);
  const names = list.result.tools.map((tool) => tool.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`tool names mismatch: ${names.join(", ")}`);
  }
  console.log(`ok: tools/list → ${list.result.tools.map((tool) => tool.name).join(", ")}`);
}

// --- 1. Missing key stays connected and explains setup in-band -------------
{
  const env = { ...process.env };
  delete env.TINIFY_API_KEY;
  const session = startSession(env);
  try {
    await initialize(session, 1);
    await assertToolList(session, 2);
    session.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_usage", arguments: {} },
    });
    const call = await session.waitFor(3, "unconfigured tool result");
    const text = call.result?.content?.[0]?.text ?? "";
    if (call.result?.isError !== true || !text.includes("TINIFY_API_KEY is not set")) {
      fail(`missing-key tool result was not actionable: ${JSON.stringify(call)}`);
    }
    if (!session.getStderr().includes("TINIFY_API_KEY is not set")) {
      fail(`missing-key stderr not readable:\n${session.getStderr()}`);
    }
    console.log("ok: missing key returns an actionable MCP tool error");
  } finally {
    await session.stop();
  }
}

// --- 2. Configured server initializes and lists all tools -------------------
{
  const session = startSession({
    ...process.env,
    TINIFY_API_KEY: "tnf_test_smoke_key",
  });
  try {
    await initialize(session, 11);
    await assertToolList(session, 12);
  } finally {
    await session.stop();
  }
}

console.log("SMOKE PASS");
