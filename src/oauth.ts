import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { API_KEY_PATTERN } from "./auth-shared.js";
import type { TinifyLikeClient } from "./tools/shared.js";

/**
 * Minimal MCP-spec OAuth 2.1 authorization server, served in-process by the
 * same node:http listener that serves /mcp.
 *
 * WHY this exists: ChatGPT connectors and the claude.ai connector directory
 * only speak "OAuth" or "no auth" - they will not let a user paste a raw
 * `Authorization: Bearer tnf_...` header. This provider implements the exact
 * dance those clients perform (RFC 8414 metadata, RFC 7591 dynamic client
 * registration, RFC 7636 PKCE authorization-code flow) while keeping the
 * user's real credential = their Tinify API key.
 *
 * TOKEN INDIRECTION: the user pastes their tnf_ key on our /authorize page.
 * We validate it against the Tinify API, then mint an OPAQUE access token
 * (mcp_at_...) that maps server-side to the key. The tnf_ key is NEVER handed
 * back to the client and NEVER appears in a token. /mcp resolves the opaque
 * token back to the key per request.
 *
 * STORAGE TRADEOFF: all state (registered clients, auth codes, tokens) lives
 * in in-memory Maps. A process restart wipes them. That is acceptable because:
 *   - clients re-register via DCR automatically on the next connect,
 *   - auth codes live 60s so a restart at worst forces one re-auth,
 *   - a wiped access token just makes the client re-run the OAuth flow (which
 *     is one paste of the key again). No durable secret is lost.
 * Moving to a shared/persistent store (Redis, sqlite) is the obvious v2.
 */

const AUTH_CODE_TTL_MS = 60_000; // 60s - single-use, short-lived.
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days.
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days.

/** Cap on stored registrations/tokens so a hostile client can't OOM us. */
const MAX_STORED_ENTRIES = 50_000;

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  apiKey: string;
  expiresAt: number;
}

interface AccessToken {
  apiKey: string;
  clientId: string;
  expiresAt: number;
}

interface RefreshToken {
  apiKey: string;
  clientId: string;
  expiresAt: number;
}

export interface OAuthProviderOptions {
  /**
   * Builds a Tinify client for a candidate key so we can validate it against
   * the live API. Reuses the same factory /mcp uses, so tests inject one
   * fetch mock for both surfaces.
   */
  clientFactory: (apiKey: string) => TinifyLikeClient;
}

export interface OAuthRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  /** Public origin of this server, e.g. https://api.tinify.dev (no trailing slash). */
  baseUrl: string;
}

/** HTML-escapes a string for safe interpolation into text or attributes. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** base64url(SHA-256(verifier)) - the S256 PKCE transform. */
function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Length-safe constant-time string compare. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** Absolute-http(s) URL, no fragment - the redirect_uri contract we enforce. */
function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.hash !== "") return false;
  // http is only allowed for loopback (native apps / local dev); everything
  // else must be https so codes are never sent in the clear.
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  }
  // Custom app schemes (e.g. com.example.app://cb) are allowed for native
  // clients; they carry no network-interception risk.
  return /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol);
}

export interface OAuthProvider {
  /** True when this path is one of the OAuth endpoints we serve. */
  isOAuthPath(pathname: string): boolean;
  /** Handles an OAuth request. Assumes CORS headers were already applied. */
  handle(ctx: OAuthRequestContext): Promise<void>;
  /** Resolves an opaque access token to its stored tnf_ key, or null. */
  resolveAccessToken(token: string): string | null;
  /** WWW-Authenticate value pointing clients at the resource metadata. */
  wwwAuthenticate(baseUrl: string): string;
}

export function createOAuthProvider(
  options: OAuthProviderOptions,
): OAuthProvider {
  const { clientFactory } = options;
  const clients = new Map<string, RegisteredClient>();
  const authCodes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, AccessToken>();
  const refreshTokens = new Map<string, RefreshToken>();

  function sweepExpired(): void {
    const now = Date.now();
    for (const [code, entry] of authCodes) {
      if (entry.expiresAt <= now) authCodes.delete(code);
    }
    for (const [token, entry] of accessTokens) {
      if (entry.expiresAt <= now) accessTokens.delete(token);
    }
    for (const [token, entry] of refreshTokens) {
      if (entry.expiresAt <= now) refreshTokens.delete(token);
    }
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function sendOAuthError(
    res: ServerResponse,
    status: number,
    error: string,
    description?: string,
  ): void {
    sendJson(
      res,
      status,
      {
        error,
        ...(description !== undefined ? { error_description: description } : {}),
      },
      { "Cache-Control": "no-store", Pragma: "no-cache" },
    );
  }

  function protectedResourceMetadata(baseUrl: string): unknown {
    return {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
    };
  }

  function authorizationServerMetadata(baseUrl: string): unknown {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      // OAuth bodies are tiny; anything past 1 MB is abuse.
      if (total > 1_000_000) throw new Error("oauth body too large");
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Parses a request body as JSON or form-urlencoded into a param getter. */
  async function readParams(
    req: IncomingMessage,
  ): Promise<Map<string, string>> {
    const raw = await readBody(req);
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const params = new Map<string, string>();
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") params.set(key, value);
          else if (Array.isArray(value)) {
            const first = value[0];
            if (typeof first === "string") params.set(key, first);
          }
        }
      } catch {
        // fall through: empty params -> caller reports invalid_request
      }
      return params;
    }
    for (const [key, value] of new URLSearchParams(raw)) {
      if (!params.has(key)) params.set(key, value);
    }
    return params;
  }

  /** POST /register - RFC 7591 dynamic client registration (open, public). */
  async function handleRegister(ctx: OAuthRequestContext): Promise<void> {
    const { req, res } = ctx;
    if (ctx.method !== "POST") {
      sendOAuthError(res, 405, "invalid_request", "Use POST to register.");
      return;
    }
    // DCR bodies are JSON with redirect_uris as an array; parse the raw body
    // directly so the array survives (readParams flattens to scalars).
    const raw = await readBody(req);
    let redirectUris: string[] = [];
    try {
      const parsed = JSON.parse(raw) as { redirect_uris?: unknown };
      if (Array.isArray(parsed.redirect_uris)) {
        redirectUris = parsed.redirect_uris.filter(
          (u): u is string => typeof u === "string",
        );
      }
    } catch {
      // Non-JSON body: try form encoding (redirect_uris may repeat).
      for (const [key, value] of new URLSearchParams(raw)) {
        if (key === "redirect_uris") redirectUris.push(value);
      }
    }

    if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
      sendOAuthError(
        res,
        400,
        "invalid_redirect_uri",
        "redirect_uris must be a non-empty array of absolute https (or loopback/custom-scheme) URLs.",
      );
      return;
    }

    if (clients.size >= MAX_STORED_ENTRIES) sweepExpired();
    const clientId = randomId("mcp_client_");
    const now = Date.now();
    clients.set(clientId, { clientId, redirectUris, createdAt: now });

    sendJson(
      res,
      201,
      {
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(now / 1000),
        // Public client: no secret is issued.
      },
      { "Cache-Control": "no-store", Pragma: "no-cache" },
    );
  }

  interface AuthorizeParams {
    responseType: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    scope: string;
  }

  /**
   * Validates the client_id + redirect_uri pair. On success returns the
   * registered client; on failure responds directly (cannot redirect to an
   * unverified URI) and returns null.
   */
  function verifyClientRedirect(
    res: ServerResponse,
    clientId: string,
    redirectUri: string,
  ): RegisteredClient | null {
    let client = clients.get(clientId);
    if (client === undefined) {
      // Lazily register an unknown client_id. Our store is in-memory, and
      // clients like ChatGPT cache their DCR client_id keyed to the MCP URL and
      // do NOT re-register after a server restart clears the store - so removing
      // and re-adding the connector replays the same forgotten client_id and
      // dead-ends. Since /register is already open, accepting a well-formed
      // client_id + redirect_uri here is no weaker than DCR, and PKCE plus the
      // user's own key at consent still gate the token exchange.
      if (!isValidRedirectUri(redirectUri)) {
        sendHtmlError(
          res,
          400,
          "Invalid redirect_uri",
          "The redirect_uri must be an absolute https (or loopback/custom-scheme) URL.",
        );
        return null;
      }
      if (clients.size >= MAX_STORED_ENTRIES) sweepExpired();
      client = { clientId, redirectUris: [redirectUri], createdAt: Date.now() };
      clients.set(clientId, client);
      return client;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      sendHtmlError(
        res,
        400,
        "Invalid redirect_uri",
        "The redirect_uri does not match any registered for this client.",
      );
      return null;
    }
    return client;
  }

  /** Builds a redirect back to the client with error params (recoverable). */
  function redirectError(
    res: ServerResponse,
    redirectUri: string,
    error: string,
    state: string,
    description?: string,
  ): void {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    if (description !== undefined) {
      target.searchParams.set("error_description", description);
    }
    if (state !== "") target.searchParams.set("state", state);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }

  function sendHtmlError(
    res: ServerResponse,
    status: number,
    title: string,
    message: string,
  ): void {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage({ title, error: message }));
  }

  /** GET /authorize - render the "Connect Tinify" key-entry page. */
  function handleAuthorizeGet(ctx: OAuthRequestContext): void {
    const { res, url } = ctx;
    const p = readAuthorizeQuery(url);
    const client = verifyClientRedirect(res, p.clientId, p.redirectUri);
    if (client === null) return;

    if (p.responseType !== "code") {
      redirectError(
        res,
        p.redirectUri,
        "unsupported_response_type",
        p.state,
        "Only response_type=code is supported.",
      );
      return;
    }
    if (p.codeChallenge === "" || p.codeChallengeMethod !== "S256") {
      redirectError(
        res,
        p.redirectUri,
        "invalid_request",
        p.state,
        "PKCE is required: send code_challenge with code_challenge_method=S256.",
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage({ title: "Connect Tinify", form: p }));
  }

  function readAuthorizeQuery(url: URL): AuthorizeParams {
    const q = url.searchParams;
    return {
      responseType: q.get("response_type") ?? "",
      clientId: q.get("client_id") ?? "",
      redirectUri: q.get("redirect_uri") ?? "",
      codeChallenge: q.get("code_challenge") ?? "",
      codeChallengeMethod: q.get("code_challenge_method") ?? "",
      state: q.get("state") ?? "",
      scope: q.get("scope") ?? "",
    };
  }

  /** POST /authorize - validate the pasted key and mint an auth code. */
  async function handleAuthorizePost(ctx: OAuthRequestContext): Promise<void> {
    const { req, res } = ctx;
    const params = await readParams(req);
    const p: AuthorizeParams = {
      responseType: params.get("response_type") ?? "",
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      codeChallenge: params.get("code_challenge") ?? "",
      codeChallengeMethod: params.get("code_challenge_method") ?? "",
      state: params.get("state") ?? "",
      scope: params.get("scope") ?? "",
    };

    const client = verifyClientRedirect(res, p.clientId, p.redirectUri);
    if (client === null) return;
    if (p.codeChallenge === "" || p.codeChallengeMethod !== "S256") {
      redirectError(
        res,
        p.redirectUri,
        "invalid_request",
        p.state,
        "PKCE is required (S256).",
      );
      return;
    }

    const apiKey = (params.get("api_key") ?? "").trim();
    if (!API_KEY_PATTERN.test(apiKey)) {
      // Never echo the entered value back into the page.
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderPage({
          title: "Connect Tinify",
          form: p,
          error:
            "That does not look like a Tinify API key. It should start with tnf_live_ or tnf_test_.",
        }),
      );
      return;
    }

    let keyValid = false;
    try {
      await clientFactory(apiKey).usage();
      keyValid = true;
    } catch {
      keyValid = false;
    }
    if (!keyValid) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderPage({
          title: "Connect Tinify",
          form: p,
          error:
            "We could not verify that key against the Tinify API. Check it and try again.",
        }),
      );
      return;
    }

    if (authCodes.size >= MAX_STORED_ENTRIES) sweepExpired();
    const code = randomId("mcp_ac_");
    authCodes.set(code, {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      apiKey,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const target = new URL(p.redirectUri);
    target.searchParams.set("code", code);
    if (p.state !== "") target.searchParams.set("state", p.state);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }

  /** POST /token - authorization_code and refresh_token grants. */
  async function handleToken(ctx: OAuthRequestContext): Promise<void> {
    const { req, res } = ctx;
    if (ctx.method !== "POST") {
      sendOAuthError(res, 405, "invalid_request", "Use POST for /token.");
      return;
    }
    const params = await readParams(req);
    const grantType = params.get("grant_type") ?? "";

    if (grantType === "authorization_code") {
      await handleAuthorizationCodeGrant(res, params);
      return;
    }
    if (grantType === "refresh_token") {
      handleRefreshTokenGrant(res, params);
      return;
    }
    sendOAuthError(
      res,
      400,
      "unsupported_grant_type",
      "Supported: authorization_code, refresh_token.",
    );
  }

  async function handleAuthorizationCodeGrant(
    res: ServerResponse,
    params: Map<string, string>,
  ): Promise<void> {
    const code = params.get("code") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const clientId = params.get("client_id") ?? "";

    // Single-use: consume the code the moment it is presented, so a replay
    // (or a leaked code used twice) always fails.
    const entry = authCodes.get(code);
    authCodes.delete(code);

    if (entry === undefined || entry.expiresAt <= Date.now()) {
      sendOAuthError(res, 400, "invalid_grant", "Unknown or expired code.");
      return;
    }
    if (codeVerifier === "") {
      sendOAuthError(res, 400, "invalid_request", "code_verifier is required (PKCE).");
      return;
    }
    if (!constantTimeEqual(s256Challenge(codeVerifier), entry.codeChallenge)) {
      sendOAuthError(res, 400, "invalid_grant", "PKCE verification failed.");
      return;
    }
    if (redirectUri !== entry.redirectUri) {
      sendOAuthError(res, 400, "invalid_grant", "redirect_uri mismatch.");
      return;
    }
    if (clientId !== "" && clientId !== entry.clientId) {
      sendOAuthError(res, 400, "invalid_grant", "client_id mismatch.");
      return;
    }

    issueTokens(res, entry.apiKey, entry.clientId, params.get("scope"));
  }

  function handleRefreshTokenGrant(
    res: ServerResponse,
    params: Map<string, string>,
  ): void {
    const refreshToken = params.get("refresh_token") ?? "";
    const clientId = params.get("client_id") ?? "";

    const entry = refreshTokens.get(refreshToken);
    if (entry === undefined || entry.expiresAt <= Date.now()) {
      refreshTokens.delete(refreshToken);
      sendOAuthError(res, 400, "invalid_grant", "Unknown or expired refresh_token.");
      return;
    }
    if (clientId !== "" && clientId !== entry.clientId) {
      sendOAuthError(res, 400, "invalid_grant", "client_id mismatch.");
      return;
    }
    // Rotate the refresh token on every use.
    refreshTokens.delete(refreshToken);
    issueTokens(res, entry.apiKey, entry.clientId, params.get("scope"));
  }

  function issueTokens(
    res: ServerResponse,
    apiKey: string,
    clientId: string,
    scope: string | null | undefined,
  ): void {
    if (accessTokens.size >= MAX_STORED_ENTRIES) sweepExpired();
    const now = Date.now();
    const accessToken = randomId("mcp_at_");
    const refreshToken = randomId("mcp_rt_");
    accessTokens.set(accessToken, {
      apiKey,
      clientId,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    refreshTokens.set(refreshToken, {
      apiKey,
      clientId,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });
    sendJson(
      res,
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
        ...(scope !== null && scope !== undefined && scope !== ""
          ? { scope }
          : {}),
      },
      { "Cache-Control": "no-store", Pragma: "no-cache" },
    );
  }

  return {
    isOAuthPath(pathname: string): boolean {
      return (
        pathname.startsWith("/.well-known/oauth-protected-resource") ||
        pathname.startsWith("/.well-known/oauth-authorization-server") ||
        pathname === "/register" ||
        pathname === "/authorize" ||
        pathname === "/token"
      );
    },

    async handle(ctx: OAuthRequestContext): Promise<void> {
      const { res, method, pathname, baseUrl } = ctx;

      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (method !== "GET" && method !== "HEAD") {
          sendOAuthError(res, 405, "invalid_request", "GET only.");
          return;
        }
        sendJson(res, 200, protectedResourceMetadata(baseUrl));
        return;
      }
      if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
        if (method !== "GET" && method !== "HEAD") {
          sendOAuthError(res, 405, "invalid_request", "GET only.");
          return;
        }
        sendJson(res, 200, authorizationServerMetadata(baseUrl));
        return;
      }
      if (pathname === "/register") {
        await handleRegister(ctx);
        return;
      }
      if (pathname === "/authorize") {
        if (method === "GET") {
          handleAuthorizeGet(ctx);
          return;
        }
        if (method === "POST") {
          await handleAuthorizePost(ctx);
          return;
        }
        sendOAuthError(res, 405, "invalid_request", "GET or POST only.");
        return;
      }
      if (pathname === "/token") {
        await handleToken(ctx);
        return;
      }
      // Should be unreachable given isOAuthPath gating.
      sendOAuthError(res, 404, "invalid_request", "Not found.");
    },

    resolveAccessToken(token: string): string | null {
      const entry = accessTokens.get(token);
      if (entry === undefined) return null;
      if (entry.expiresAt <= Date.now()) {
        accessTokens.delete(token);
        return null;
      }
      return entry.apiKey;
    },

    wwwAuthenticate(baseUrl: string): string {
      const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
      return `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`;
    },
  };
}

interface RenderPageOptions {
  title: string;
  form?: {
    responseType: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    scope: string;
  };
  error?: string;
}

/**
 * Renders the self-contained "Connect Tinify" page (no external assets, CSP
 * friendly). When `form` is present it renders the key-entry form; otherwise
 * it is an error/notice page. All interpolated values are escaped.
 */
function renderPage(options: RenderPageOptions): string {
  const { title, form, error } = options;
  const errorHtml =
    error !== undefined
      ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
      : "";

  const formHtml =
    form !== undefined
      ? `
    <form method="POST" action="/authorize" autocomplete="off">
      <input type="hidden" name="response_type" value="${escapeHtml(form.responseType)}">
      <input type="hidden" name="client_id" value="${escapeHtml(form.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(form.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(form.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(form.codeChallengeMethod)}">
      <input type="hidden" name="state" value="${escapeHtml(form.state)}">
      <input type="hidden" name="scope" value="${escapeHtml(form.scope)}">
      <label for="api_key">Tinify API key</label>
      <input id="api_key" name="api_key" type="password" inputmode="text"
             autocomplete="off" autocapitalize="off" autocorrect="off"
             spellcheck="false" required
             placeholder="tnf_live_...">
      <p class="hint">Pasted here and exchanged for a token. Create one at
        <span class="mono">tinify.dev/developers</span>. It is never logged.</p>
      <button type="submit">Authorize</button>
    </form>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  /* Design tokens: set once for light, flipped in the dark media query so
     every color stays correct regardless of the viewer's theme. */
  :root {
    color-scheme: light dark;
    --bg: #fafafa;
    --fg: #111111;
    --muted: #52525b;
    --card: #ffffff;
    --border: #e4e4e7;
    --accent: #6d28d9;
    --accent-hover: #5b21b6;
    --ring: rgba(109, 40, 217, 0.35);
    --input-bg: #ffffff;
    --shadow: 0 10px 30px rgba(0, 0, 0, 0.10);
    --err-bg: #fef2f2;
    --err-fg: #b42318;
    --err-border: #fecaca;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b;
      --fg: #fafafa;
      --muted: #a1a1aa;
      --card: #131316;
      --border: #27272a;
      --accent: #8b5cf6;
      --accent-hover: #7c3aed;
      --ring: rgba(139, 92, 246, 0.45);
      --input-bg: #1c1c20;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      --err-bg: #2a1416;
      --err-fg: #fca5a5;
      --err-border: #542426;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh; min-height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 440px;
    background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; box-shadow: var(--shadow);
  }
  h1 {
    margin: 0 0 6px; font-size: 22px; font-weight: 700;
    letter-spacing: -0.01em; color: var(--fg); opacity: 1;
  }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: 14px; }
  label {
    display: block; font-weight: 600; margin-bottom: 8px;
    font-size: 13px; color: var(--fg);
  }
  input {
    width: 100%; padding: 12px 13px; font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
                 "Liberation Mono", monospace;
    color: var(--fg); background: var(--input-bg);
    border: 1px solid var(--border); border-radius: 10px;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  input::placeholder { color: var(--muted); opacity: 1; }
  input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--ring);
  }
  .hint { font-size: 12.5px; line-height: 1.5; color: var(--muted); margin: 10px 0 20px; }
  .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  button {
    width: 100%; padding: 12px; font-size: 15px; font-weight: 600;
    color: #ffffff; background: var(--accent);
    border: 0; border-radius: 10px; cursor: pointer;
    transition: transform 140ms ease, background-color 140ms ease;
  }
  button:hover { background: var(--accent-hover); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
  button:active { transform: scale(0.98); }
  .error {
    background: var(--err-bg); color: var(--err-fg);
    border: 1px solid var(--err-border);
    padding: 11px 13px; border-radius: 10px; font-size: 13px;
    line-height: 1.45; margin: 0 0 18px;
  }
  @media (max-width: 480px) { .card { padding: 24px; } }
</style>
</head>
<body>
  <main class="card">
    <h1>Connect Tinify</h1>
    <p class="sub">Authorize this app to use the Tinify.dev image API with your key.</p>
    ${errorHtml}
    ${formHtml}
  </main>
</body>
</html>`;
}
