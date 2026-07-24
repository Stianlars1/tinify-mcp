import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TinifyClient } from "@tinify-dev/client";
import { createServer } from "./server.js";
import { REMOTE_INSTRUCTIONS, remoteTools } from "./tools/remote.js";
import type { TinifyLikeClient } from "./tools/shared.js";

/**
 * Remote (streamable-HTTP) entry for the Tinify MCP server.
 *
 * - STATELESS: every POST /mcp constructs a fresh McpServer + transport wired
 *   to a per-request TinifyClient whose API key comes from the Authorization
 *   header (Bearer tnf_live_... / tnf_test_...). No sessions, no shared state.
 * - GET /healthz returns 200 {"ok":true} for nginx/systemd health checks.
 * - Listens on 127.0.0.1 only; nginx terminates TLS at api.tinify.dev/mcp.
 */

export const DEFAULT_PORT = 3102;

/** tnf_live_* or tnf_test_* followed by at least one key character. */
const API_KEY_PATTERN = /^tnf_(?:live|test)_[A-Za-z0-9._-]+$/;

/**
 * Hard cap on the request body. Generous headroom above the 28 MB decoded
 * image limit (~37.4 MB as base64) plus JSON envelope; nginx should mirror
 * this with client_max_body_size 48m.
 */
const MAX_BODY_BYTES = 48 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

export interface HttpServerOptions {
  /**
   * Builds the per-request Tinify client from the bearer key. Overridden in
   * tests to inject a mocked fetch; defaults to the real SDK client (honoring
   * TINIFY_BASE_URL for staging).
   */
  clientFactory?: (apiKey: string) => TinifyLikeClient;
}

function defaultClientFactory(apiKey: string): TinifyLikeClient {
  const baseUrl = process.env["TINIFY_BASE_URL"];
  return new TinifyClient({
    apiKey,
    ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
  });
}

function applyCors(res: ServerResponse): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** JSON-RPC-shaped error body so MCP clients surface something readable. */
function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(
    res,
    401,
    jsonRpcError(
      -32001,
      "Unauthorized: send Authorization: Bearer tnf_live_... (or tnf_test_...). Create a key at https://tinify.dev/developers.",
    ),
    { "WWW-Authenticate": 'Bearer realm="tinify", error="invalid_token"' },
  );
}

/** Extracts a valid Tinify API key from the Authorization header, or null. */
export function extractApiKey(
  authorization: string | undefined,
): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match === null) return null;
  const key = (match[1] ?? "").trim();
  return API_KEY_PATTERN.test(key) ? key : null;
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  clientFactory: (apiKey: string) => TinifyLikeClient,
): Promise<void> {
  const apiKey = extractApiKey(req.headers.authorization);
  if (apiKey === null) {
    sendUnauthorized(res);
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(
        res,
        413,
        jsonRpcError(
          -32600,
          `Request body exceeds ${MAX_BODY_BYTES} bytes. Images are limited to ~28 MB decoded (~37 MB as base64).`,
        ),
      );
      return;
    }
    throw error;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, jsonRpcError(-32700, "Parse error: body is not valid JSON."));
    return;
  }

  // Fresh server + transport per request: stateless mode, nothing shared
  // between callers, and the bearer key scopes every upstream API call.
  const client = clientFactory(apiKey);
  const mcpServer = createServer(client, remoteTools, REMOTE_INSTRUCTIONS);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once("close", () => {
    void transport.close();
    void mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

/**
 * Builds the Node HTTP server (does not listen). Exported for tests; the
 * production entry below listens on 127.0.0.1:$PORT.
 */
export function createHttpServer(options: HttpServerOptions = {}): Server {
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  return createNodeHttpServer((req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname !== "/mcp") {
      sendJson(res, 404, jsonRpcError(-32601, `Not found: ${pathname}. The MCP endpoint is POST /mcp.`));
      return;
    }

    applyCors(res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method !== "POST") {
      sendJson(
        res,
        405,
        jsonRpcError(
          -32000,
          "Method not allowed. This server is stateless: use POST /mcp (no GET stream, no sessions).",
        ),
        { Allow: "POST, OPTIONS" },
      );
      return;
    }

    handleMcpPost(req, res, clientFactory).catch((error: unknown) => {
      console.error(
        "tinify-mcp-http: request failed:",
        error instanceof Error ? error.message : error,
      );
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, "Internal server error."));
      } else {
        res.end();
      }
    });
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`tinify-mcp-http: invalid PORT "${process.env["PORT"]}"`);
    process.exit(1);
  }
  const server = createHttpServer();
  server.listen(port, "127.0.0.1", () => {
    console.error(
      `tinify-mcp-http: streamable HTTP listening on 127.0.0.1:${port} (POST /mcp, GET /healthz, 5 tools, stateless)`,
    );
  });
  const shutdown = (): void => {
    server.close(() => process.exit(0));
    // Do not wait forever on idle keep-alive sockets.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
