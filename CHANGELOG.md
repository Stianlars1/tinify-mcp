# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
