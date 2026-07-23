# @tinify-dev/mcp

MCP (Model Context Protocol) server for the [Tinify.dev](https://tinify.dev/developers) image API. Lets Claude, Cursor, and any other MCP client compress, resize, crop, and convert local images — with honest results.

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
