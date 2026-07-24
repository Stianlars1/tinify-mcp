import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compressImageTool } from "./tools/compress.js";
import { convertImageTool } from "./tools/convert.js";
import { cropImageTool } from "./tools/crop.js";
import { resizeImageTool } from "./tools/resize.js";
import { getUsageTool } from "./tools/usage.js";
import type { TinifyLikeClient } from "./tools/shared.js";

export const SERVER_NAME = "tinify";
export const SERVER_VERSION = "0.1.3";

// Human-facing serverInfo (MCP 2025-11-25 Implementation fields). Clients that
// render connector branding (title/website/icon) read these off the initialize
// handshake, as do the MCP registry/directories.
export const SERVER_TITLE = "Tinify image tools";
export const SERVER_DESCRIPTION =
  "Compress, resize, crop, and convert images with the Tinify.dev API. Honest results: never returns a larger file.";
export const SERVER_WEBSITE_URL = "https://tinify.dev/mcp";
export const SERVER_ICON_URL = "https://tinify.dev/tinify-icon.png";

const STDIO_INSTRUCTIONS =
  "Tools for the Tinify.dev image API: compress, resize, crop, and convert local images, plus account usage. Image paths must be absolute. Results are written as <name>.min.<ext> next to the input unless output_path is given; source files are never overwritten silently.";

/** Shape every registerable tool module exports. */
export interface RegisterableTool {
  name: string;
  config: unknown;
  makeHandler(client: TinifyLikeClient): unknown;
}

export const allTools = [
  compressImageTool,
  resizeImageTool,
  cropImageTool,
  convertImageTool,
  getUsageTool,
] as const;

/**
 * Builds an McpServer wired to the given client. Defaults to the stdio
 * (local-filesystem) toolset; the remote HTTP entry passes the base64
 * toolset and its own instructions instead.
 */
export function createServer(
  client: TinifyLikeClient,
  tools: readonly RegisterableTool[] = allTools,
  instructions: string = STDIO_INSTRUCTIONS,
): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: SERVER_TITLE,
      description: SERVER_DESCRIPTION,
      websiteUrl: SERVER_WEBSITE_URL,
      icons: [
        {
          src: SERVER_ICON_URL,
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    },
    { instructions },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      tool.config as never,
      tool.makeHandler(client) as never,
    );
  }
  return server;
}
