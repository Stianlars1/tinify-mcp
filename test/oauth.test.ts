import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TinifyClient } from "@tinify-dev/client";
import { createHttpServer } from "../src/http.js";

const VALID_KEY = "tnf_test_oauth_valid_key_1";
const REDIRECT_URI = "https://client.example/callback";

/**
 * Mock upstream that validates a Tinify key by the Authorization header on
 * GET /api/v1/usage: keys in `validKeys` get 200, everything else 401. This is
 * exactly the signal /authorize uses to accept or reject a pasted key.
 */
function makeMockFetch(validKeys: Set<string>): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers["authorization"] ?? headers["Authorization"] ?? "";
      const key = auth.replace(/^Bearer\s+/i, "");
      if (url.includes("/api/v1/usage")) {
        if (validKeys.has(key)) {
          return new Response(
            JSON.stringify({
              plan: "developer",
              period_start: "2026-07-01",
              period_end: "2026-07-31",
              included: 500,
              reserved: 0,
              used: 1,
              remaining: 499,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-request-id": "req_usage_oauth_1",
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "Invalid API key." },
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_usage_oauth_401",
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
  seenApiKeys: string[];
}

let running: Server | undefined;

async function startServer(
  validKeys: Set<string> = new Set([VALID_KEY]),
): Promise<TestContext> {
  const { fetch: mockFetch } = makeMockFetch(validKeys);
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
  return { baseUrl: `http://127.0.0.1:${port}`, seenApiKeys };
}

afterEach(async () => {
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function postForm(
  baseUrl: string,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

/** Runs register -> authorize -> token and returns the token response. */
async function fullDance(
  baseUrl: string,
  overrides: { verifierForToken?: string } = {},
): Promise<{
  clientId: string;
  verifier: string;
  code: string;
  tokenRes: Response;
}> {
  const clientId = await register(baseUrl);
  const { verifier, challenge } = pkce();
  const authRes = await postForm(baseUrl, "/authorize", {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz-state",
    api_key: VALID_KEY,
  });
  expect(authRes.status).toBe(302);
  const location = authRes.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code") ?? "";
  const tokenRes = await postForm(baseUrl, "/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: overrides.verifierForToken ?? verifier,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
  });
  return { clientId, verifier, code, tokenRes };
}

describe("OAuth metadata", () => {
  it("serves protected-resource metadata", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe(`${baseUrl}/mcp`);
    expect(body.authorization_servers).toEqual([baseUrl]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves authorization-server metadata", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("401 on /mcp carries WWW-Authenticate resource_metadata", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe("dynamic client registration", () => {
  it("returns a generated client_id, no secret, public client", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["client_id"]).toBe("string");
    expect(body["client_id"]).not.toBe("");
    expect(body["client_secret"]).toBeUndefined();
    expect(body["token_endpoint_auth_method"]).toBe("none");
    expect(body["redirect_uris"]).toEqual([REDIRECT_URI]);
  });

  it("rejects registration without a valid redirect_uri", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });
});

describe("authorize page", () => {
  it("GET /authorize renders the key-entry form", async () => {
    const { baseUrl } = await startServer();
    const clientId = await register(baseUrl);
    const { challenge } = pkce();
    const url = new URL(`${baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "abc");
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connect Tinify");
    expect(html).toContain('name="api_key"');
    expect(html).toContain(challenge); // PKCE round-trips through the form
  });

  it("GET /authorize with an unknown client_id + valid redirect_uri lazily registers and shows the form", async () => {
    // Clients (e.g. ChatGPT) cache their DCR client_id and do not re-register
    // after a server restart clears the in-memory store; /authorize must lazily
    // register a well-formed unknown client_id instead of dead-ending.
    const { baseUrl } = await startServer();
    const { challenge } = pkce();
    const url = new URL(`${baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "mcp_client_never_registered");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connect Tinify");
    expect(html).toContain('name="api_key"');
  });

  it("GET /authorize with an unknown client_id + invalid redirect_uri errors, no redirect", async () => {
    const { baseUrl } = await startServer();
    const { challenge } = pkce();
    const url = new URL(`${baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "mcp_client_bogus");
    // Plain http, non-loopback: not an acceptable redirect_uri, so no lazy
    // registration and no redirect to an unverified URI.
    url.searchParams.set("redirect_uri", "http://insecure.example/cb");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("GET /authorize without PKCE redirects with error=invalid_request", async () => {
    const { baseUrl } = await startServer();
    const clientId = await register(baseUrl);
    const url = new URL(`${baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", "s1");
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("state")).toBe("s1");
  });

  it("POST /authorize with an invalid key re-renders with an error", async () => {
    const { baseUrl, seenApiKeys } = await startServer();
    const clientId = await register(baseUrl);
    const { challenge } = pkce();
    const res = await postForm(baseUrl, "/authorize", {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      api_key: "tnf_test_this_key_is_not_valid",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("could not verify");
    // The key was checked against the upstream API.
    expect(seenApiKeys).toContain("tnf_test_this_key_is_not_valid");
  });

  it("POST /authorize with a malformed key is rejected before hitting upstream", async () => {
    const { baseUrl, seenApiKeys } = await startServer();
    const clientId = await register(baseUrl);
    const { challenge } = pkce();
    const res = await postForm(baseUrl, "/authorize", {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      api_key: "not-a-key-at-all",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("tnf_live_");
    expect(seenApiKeys).toEqual([]); // never validated upstream
  });
});

describe("full PKCE authorization-code flow", () => {
  it("register -> authorize -> token -> access_token drives /mcp", async () => {
    const { baseUrl } = await startServer();
    const { tokenRes } = await fullDance(baseUrl);
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
    };
    expect(token.token_type).toBe("Bearer");
    expect(token.expires_in).toBeGreaterThan(0);
    expect(typeof token.refresh_token).toBe("string");

    // The access token is opaque: it is not the tnf_ key.
    expect(token.access_token).not.toBe(VALID_KEY);
    expect(token.access_token.startsWith("tnf_")).toBe(false);

    // It resolves on /mcp and lists the remote tools.
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([
      "compress_image",
      "convert_image",
      "crop_image",
      "get_usage",
      "resize_image",
    ]);
  });

  it("rejects a bad PKCE verifier at the token endpoint", async () => {
    const { baseUrl } = await startServer();
    const { tokenRes } = await fullDance(baseUrl, {
      verifierForToken: "wrong-verifier-entirely",
    });
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("makes authorization codes single-use", async () => {
    const { baseUrl } = await startServer();
    const clientId = await register(baseUrl);
    const { verifier, challenge } = pkce();
    const authRes = await postForm(baseUrl, "/authorize", {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      api_key: VALID_KEY,
    });
    const code =
      new URL(authRes.headers.get("location") ?? "").searchParams.get("code") ??
      "";
    const first = await postForm(baseUrl, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    });
    expect(first.status).toBe(200);
    const second = await postForm(baseUrl, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("exchanges a refresh_token for a fresh access token", async () => {
    const { baseUrl } = await startServer();
    const { clientId, tokenRes } = await fullDance(baseUrl);
    const first = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const refreshRes = await postForm(baseUrl, "/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      token_type: string;
      refresh_token: string;
    };
    expect(refreshed.token_type).toBe("Bearer");
    expect(refreshed.access_token).not.toBe(first.access_token);

    // The new access token works on /mcp.
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${refreshed.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);

    // The rotated (old) refresh token is no longer accepted.
    const reuse = await postForm(baseUrl, "/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
  });

  it("rejects an unsupported grant_type", async () => {
    const { baseUrl } = await startServer();
    const res = await postForm(baseUrl, "/token", {
      grant_type: "password",
      username: "x",
      password: "y",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });
});

describe("direct tnf_ bearer still works alongside OAuth", () => {
  it("accepts a direct tnf_ key on /mcp (unchanged behavior)", async () => {
    const { baseUrl, seenApiKeys } = await startServer();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${VALID_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    // The direct key became the per-request TinifyClient key, no OAuth needed.
    expect(seenApiKeys).toEqual([VALID_KEY]);
  });
});
