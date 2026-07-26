# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
