import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TinifyClient } from "@tinify-dev/client";
import { createHttpServer, extractApiKey } from "../src/http.js";
import { MAX_REMOTE_IMAGE_BYTES } from "../src/tools/remote.js";

const TEST_KEY = "tnf_test_unit_key_1";
const RESULT_BYTES = new Uint8Array([9, 8, 7, 6, 5]);
const TINY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const TINY_PNG_B64 = Buffer.from(TINY_PNG).toString("base64");

/** Mimics the Tinify.dev API for the real TinifyClient with injected fetch. */
function makeMockFetch(): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/v1/images/")) {
        return new Response(
          JSON.stringify({
            request_id: "req_http_1",
            data: {
              job_id: "job_http_1",
              status: "succeeded",
              optimized: true,
              original_bytes: 319_897,
              result_bytes: 99_430,
              width: 1200,
              height: 800,
              download_url: "https://api.tinify.dev/dl/http-test",
              expires_at: "2026-07-24T12:00:00Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/dl/http-test")) {
        return new Response(RESULT_BYTES.slice().buffer as ArrayBuffer, {
          status: 200,
        });
      }
      if (url.includes("/api/v1/usage")) {
        return new Response(
          JSON.stringify({
            plan: "developer",
            period_start: "2026-07-01",
            period_end: "2026-07-31",
            included: 500,
            reserved: 0,
            used: 132,
            remaining: 368,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_usage_http_1",
            },
          },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );
  return { fetch: fetchImpl, calls };
}

interface TestContext {
  baseUrl: string;
  server: Server;
  calls: string[];
  seenApiKeys: string[];
}

let running: Server | undefined;

async function startServer(): Promise<TestContext> {
  const { fetch: mockFetch, calls } = makeMockFetch();
  const seenApiKeys: string[] = [];
  const server = createHttpServer({
    clientFactory: (apiKey) => {
      seenApiKeys.push(apiKey);
      return new TinifyClient({ apiKey, fetch: mockFetch });
    },
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  running = server;
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server, calls, seenApiKeys };
}

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

function rpcHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TEST_KEY}`,
    ...overrides,
  };
}

async function rpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: rpcHeaders(headers),
    body: JSON.stringify(body),
  });
}

function initializeBody(id = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.0.0" },
    },
  };
}

describe("extractApiKey", () => {
  it("accepts tnf_live_ and tnf_test_ bearer keys", () => {
    expect(extractApiKey("Bearer tnf_live_abc123")).toBe("tnf_live_abc123");
    expect(extractApiKey("bearer tnf_test_abc123")).toBe("tnf_test_abc123");
  });

  it("rejects missing, malformed, and foreign keys", () => {
    expect(extractApiKey(undefined)).toBeNull();
    expect(extractApiKey("")).toBeNull();
    expect(extractApiKey("tnf_live_abc123")).toBeNull(); // no Bearer scheme
    expect(extractApiKey("Basic dXNlcjpwdw==")).toBeNull();
    expect(extractApiKey("Bearer sk_live_wrong_vendor")).toBeNull();
    expect(extractApiKey("Bearer tnf_prod_nope")).toBeNull();
  });
});

describe("remote HTTP server", () => {
  it("GET /healthz returns 200 {ok:true} without auth", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects POST /mcp without Authorization: 401 + WWW-Authenticate + CORS", async () => {
    const { baseUrl, seenApiKeys } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeBody()),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="tinify", error="invalid_token"',
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("tnf_live_");
    expect(seenApiKeys).toEqual([]);
  });

  it("rejects malformed bearer tokens with 401", async () => {
    const { baseUrl } = await startServer();
    const res = await rpc(baseUrl, initializeBody(), {
      authorization: "Bearer not_a_tinify_key",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("answers OPTIONS /mcp preflight with 204 and the CORS contract", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, Mcp-Session-Id, mcp-protocol-version",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });

  it("rejects GET /mcp with 405 (stateless, POST only)", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: rpcHeaders(),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("initialize + tools/list round-trip lists the five remote tools", async () => {
    const { baseUrl } = await startServer();

    const initRes = await rpc(baseUrl, initializeBody());
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("access-control-allow-origin")).toBe("*");
    const init = (await initRes.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe("tinify");

    // Stateless: a fresh POST (fresh server instance) serves tools/list.
    const listRes = await rpc(baseUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      result: { tools: Array<{ name: string; description?: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name).sort()).toEqual([
      "compress_image",
      "convert_image",
      "crop_image",
      "get_usage",
      "resize_image",
    ]);
    const compress = list.result.tools.find(
      (tool) => tool.name === "compress_image",
    );
    expect(compress?.description).toContain("base64");
  });

  it("compress_image round-trip: base64 in, base64 out, per-request API key", async () => {
    const { baseUrl, calls, seenApiKeys } = await startServer();
    const res = await rpc(baseUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "compress_image",
        arguments: { image_base64: TINY_PNG_B64, filename: "photo.png" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
      };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain("312.4 KB → 97.1 KB");
    expect(body.result.content[0]?.text).toContain("base64");
    expect(body.result.structuredContent).toMatchObject({
      original_bytes: 319_897,
      result_bytes: 99_430,
      saved_bytes: 220_467,
      change_percent: -68.9,
      optimized: true,
      image_base64: Buffer.from(RESULT_BYTES).toString("base64"),
      filename: "photo.min.png",
      request_id: "req_http_1",
    });
    // The bearer key became the per-request TinifyClient key.
    expect(seenApiKeys).toEqual([TEST_KEY]);
    expect(calls.some((url) => url.includes("/api/v1/images/compress"))).toBe(
      true,
    );
  });

  it("get_usage passes through unchanged", async () => {
    const { baseUrl } = await startServer();
    const res = await rpc(baseUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_usage", arguments: {} },
    });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0]?.text).toContain(
      "Plan developer: 132 of 500 operations used",
    );
  });

  it(
    "rejects oversize base64 with a clear error before calling upstream",
    { timeout: 30_000 },
    async () => {
      const { baseUrl, calls } = await startServer();
      // Just over the 28 MB decoded limit; valid base64 alphabet throughout.
      const base64Chars =
        Math.ceil((MAX_REMOTE_IMAGE_BYTES + 3) / 3) * 4;
      const oversized = "A".repeat(base64Chars);
      const res = await rpc(baseUrl, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "compress_image",
          arguments: { image_base64: oversized },
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("28.0 MB limit");
      expect(body.result.content[0]?.text).toContain("exceeds");
      expect(calls).toEqual([]);
    },
  );

  it("returns 400 with a JSON-RPC parse error for invalid JSON", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: rpcHeaders(),
      body: "{nope",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});
