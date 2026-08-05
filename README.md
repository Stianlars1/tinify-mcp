# @tinify-dev/mcp

MCP (Model Context Protocol) server for the [Tinify.dev](https://tinify.dev/developers) image API. Lets ChatGPT, Claude, Cursor, and other MCP clients compress, resize, crop, and convert images — with honest results.

```text
You: compress the screenshots in ~/Desktop/launch/
Claude: 312.4 KB → 97.1 KB (-68.9%), wrote /Users/you/Desktop/launch/hero.min.png
        84.2 KB → 84.2 KB — logo.png is already as small as Tinify.dev can make it
        (optimized: false), so no file was written.
```

- **Never lies about savings** — when the API cannot shrink a file it says so (`optimized: false`) instead of writing a byte-identical "optimized" copy.
- **Never overwrites your originals silently** — results go to `<name>.min.<ext>` beside the input, or to an explicit `output_path`. Replacing a file requires `overwrite: true`.
- **Raw numbers in `structuredContent`** on every call, so agents can do math instead of parsing prose.

> Not affiliated with TinyPNG. This server talks to the Tinify.dev API.

## Requirements

- Node.js >= 20
- A Tinify.dev API key from [tinify.dev/developers](https://tinify.dev/developers) — free tier is 500 operations/month, no card required.

## Setup

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "tinify": {
      "command": "npx",
      "args": ["-y", "@tinify-dev/mcp"],
      "env": { "TINIFY_API_KEY": "tnf_live_..." }
    }
  }
}
```

### Claude Code

```sh
claude mcp add tinify -e TINIFY_API_KEY=tnf_live_... -- npx -y @tinify-dev/mcp
```

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "tinify": {
      "command": "npx",
      "args": ["-y", "@tinify-dev/mcp"],
      "env": { "TINIFY_API_KEY": "tnf_live_..." }
    }
  }
}
```

## Remote server (hosted)

The same five tools are available as a hosted streamable-HTTP MCP server - no install, works from ChatGPT connectors, the claude.ai directory, and any registry that expects a URL:

```text
Endpoint:  https://api.tinify.dev/mcp
Auth:      OAuth 2.1 (PKCE + dynamic client registration), or
           Authorization: Bearer tnf_live_...   (or tnf_test_...)
```

Two ways to authenticate:

- **OAuth (for connectors)** - ChatGPT connectors and the claude.ai directory only speak "OAuth" or "no auth". Add the server by its URL (`https://api.tinify.dev/mcp`) and pick **OAuth**; the client discovers the authorization and token endpoints automatically from the server's `.well-known` metadata, registers itself, and opens a **Connect Tinify** page where you paste your Tinify API key. Your key stays the credential - the client only ever holds an opaque token that maps back to it server-side.
- **Direct bearer (for scripts/CLIs)** - send `Authorization: Bearer tnf_live_...` (or `tnf_test_...`) and skip OAuth entirely. Unchanged.

### ChatGPT developer-mode connection

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, and add `https://api.tinify.dev/mcp`.
3. Complete **Connect Tinify** with a Tinify API key.
4. Add the connection from the conversation's tools menu, attach a PNG/JPEG/WebP/AVIF, and ask:

   ```text
   Use Tinify to compress this image for the web. Show the original size,
   result size, and percentage saved.
   ```

The hosted server cannot access local paths, so each image tool accepts exactly one of:

- `image` — the ChatGPT attachment object. ChatGPT fills this automatically because the descriptor advertises `openai/fileParams`.
- `image_base64` — a portable fallback for other MCP clients, capped at ~28 MB decoded.

ChatGPT attachment downloads are HTTPS-only, reject private/reserved network targets and redirects, time out after 30 seconds, and are capped at the Tinify API's 40 MB limit. Successful operations return exact byte metrics and a temporary MCP result link. Existing base64 callers also receive `structuredContent.image_base64` for backwards compatibility. `get_usage` is identical to the local version. Nothing is written to the user's filesystem.

Try it with curl:

```sh
curl -s https://api.tinify.dev/mcp \
  -H "Authorization: Bearer tnf_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

For local files, prefer the stdio server above - it reads and writes them directly with no base64 round-trip and no 28 MB cap.

### One server, two transport adapters

This repository intentionally supports both OpenAI and Claude:

- The shared tool names, Tinify client, result metrics, errors, and annotations are platform-neutral.
- The stdio adapter uses absolute local paths and writes files for desktop/CLI clients such as Claude, Cursor, and Codex.
- The hosted adapter uses ChatGPT file attachments or base64 and returns temporary result links because hosted servers cannot read a user's filesystem.

An OpenAI-only repository would duplicate the Tinify logic and make behavior drift more likely. OpenAI-specific descriptor metadata stays as a small additive layer in the hosted adapter; a separate repository is not needed.

For public OpenAI submission, set the portal-provided domain token as
`OPENAI_APPS_CHALLENGE_TOKEN` in `/etc/tinify/mcp-http.env` and deploy the
matching nginx location from `deploy/nginx-location.conf`. The endpoint returns
only that token at `/.well-known/openai-apps-challenge`; do not commit the real
portal token.

## Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `compress_image` | `path` (absolute), `output_path?`, `quality_mode?` (`balanced`/`best_quality`/`lossless`), `target_size_kb?` (beta), `overwrite?` | Compresses PNG/JPEG/WebP/AVIF. Writes `<name>.min.<ext>` beside the input. When the API returns `optimized: false`, nothing is written (unless you asked for an explicit `output_path`). |
| `resize_image` | `path`, `width?`/`height?`/`scale?` (at least one), `keep_aspect_ratio?`, `output_path?`, `overwrite?` | Resizes and writes the result. |
| `crop_image` | `path`, `x`, `y`, `width`, `height`, `output_path?`, `overwrite?` | Crops to a rectangle and writes the result. |
| `convert_image` | `path`, `format` (`avif`/`webp`/`jpeg`/`png`), `quality_mode?`, `output_path?`, `overwrite?` | Converts formats (**beta** — the endpoint is rolling out server-side). Default output: `<name>.min.<new-ext>`. |
| `get_usage` | — | Plan, billing period, operations used and remaining. |

All image tools require **absolute paths** (MCP servers run with an unpredictable working directory) and pre-check the **40 MB** API limit locally. API errors come back as readable tool errors with the error `code` and `request_id` to quote to support.

## Example prompts

- "Compress every PNG in /Users/me/site/static/img"
- "Resize /Users/me/photo.jpg to 1200px wide and tell me how many bytes it saved"
- "Convert /Users/me/hero.png to webp with best quality"
- "How many Tinify operations do I have left this month?"

## Limits and privacy

- Max **40 MB / 50 MP** per image; PNG, JPEG, WebP, AVIF.
- Uploaded images and results are deleted from Tinify.dev servers after **2 hours**.
- The server only reads the files you point it at and only writes where it tells you it wrote.

## Troubleshooting

- **"TINIFY_API_KEY is not set"** — the server exits at startup with the exact config snippet to fix it. Add the key to the `env` block of your MCP config.
- **`invalid_api_key`** — the key is wrong or revoked; create a new one at [tinify.dev/developers](https://tinify.dev/developers).
- **`quota_exhausted` (429)** — the monthly quota is used up; run `get_usage` to see the period end.
- **"path must be absolute"** — pass full paths like `/Users/you/img.png`, not `./img.png`.
- Logs go to stderr; in Claude Desktop see `~/Library/Logs/Claude/mcp-server-tinify.log`.

## Roadmap

- Batch tools (create/commit/wait/download) on top of the durable batch API — not in v1.

## License

MIT © Stian Larsen

## One-click / one-line installs

**Cursor**: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=tinify&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0aW5pZnktZGV2L21jcCJdLCJlbnYiOnsiVElOSUZZX0FQSV9LRVkiOiJZT1VSX0FQSV9LRVkifX0=) - then set your real key in Cursor's MCP settings.

**VS Code**:

```sh
code --add-mcp '{"name":"tinify","command":"npx","args":["-y","@tinify-dev/mcp"],"env":{"TINIFY_API_KEY":"tnf_live_..."}}'
```

**Codex CLI**:

```sh
codex mcp add tinify --env TINIFY_API_KEY=tnf_live_... -- npx -y @tinify-dev/mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.tinify]
command = "npx"
args = ["-y", "@tinify-dev/mcp"]

[mcp_servers.tinify.env]
TINIFY_API_KEY = "tnf_live_..."
```

**Claude Code plugin** (MCP + image-optimization skill):

```
/plugin marketplace add Stianlars1/tinify-claude-plugin
/plugin install tinify@tinify
```

More: https://tinify.dev/mcp
