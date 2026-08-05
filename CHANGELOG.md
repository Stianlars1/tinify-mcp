# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.7] - 2026-08-05

### Changed

- Releases are published through npm trusted publishing (OIDC) with
  provenance - no long-lived npm token exists anywhere in the pipeline.
- The Claude Desktop bundle (.mcpb) is built, validated, and attached to the
  GitHub release automatically on every tag, so it can no longer lag behind
  the npm version. No runtime changes to the server or tools.

## [0.1.6] - 2026-08-05

### Added

- ChatGPT attachment inputs on every hosted image tool using the documented
  `openai/fileParams` file object contract.
- Temporary MCP `resource_link` results so ChatGPT can present the processed
  image without moving megabytes of base64 through the model context.
- Bounded attachment downloads: HTTPS only, public DNS only, no redirects,
  30-second timeout, MIME checks, and the upstream 40 MB size limit.
- Per-tool OAuth metadata and the `tinify:use` scope for the hosted server.
- An environment-backed `/.well-known/openai-apps-challenge` endpoint for
  OpenAI domain verification without checking a portal token into source.

### Changed

- The hosted tools now accept exactly one of `image` (ChatGPT attachment) or
  `image_base64` (portable fallback). Existing base64 callers still receive
  `structuredContent.image_base64`.
- OAuth authorization codes, access tokens, and refresh tokens are bound to
  the advertised MCP resource and cannot be exchanged for another resource.
- Hosted tool descriptions now state their private Tinify operation and
  temporary result-link behavior for OpenAI review.

## [0.1.5] - 2026-07-26

### Changed

- **Starting without `TINIFY_API_KEY` no longer exits.** The server completes
  the MCP handshake and registers its tools; calling one returns the
  "create a key" instruction as a tool result. Previously the process exited 1
  before the handshake, so MCP clients showed only a failed connection and the
  explanation — written to stderr on an already-dead process — never reached
  the user. This is the state anyone is in immediately after installing the
  Claude Code plugin but before exporting a key. The message is still printed
  to stderr at startup for people running the binary directly.

### Added

- `repository`, `homepage`, and `bugs` in `package.json`, so the npm page links
  back to the source and to tinify.dev.

## [0.1.0] - 2026-07-24

### Added

- Initial release: stdio MCP server for the Tinify.dev image API.
- Tools: `compress_image`, `resize_image`, `crop_image`, `convert_image`
  (beta endpoint), `get_usage`.
- Absolute-path validation, 40 MB pre-guard, and safe output handling:
  results are written as `<name>.min.<ext>` next to the input (or to an
  explicit `output_path`); source images are never overwritten silently.
- Honest summaries, including the `optimized: false` case where the API
  returns the original bytes because it could not shrink them.
- `structuredContent` with raw byte counts on every image tool.
- Fail-fast startup with a copy-pasteable fix when `TINIFY_API_KEY` is unset.
- MCP registry manifest (`server.json`, `dev.tinify/mcp`) and `smithery.yaml`.
