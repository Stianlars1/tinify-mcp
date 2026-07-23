import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compressImageTool } from "./tools/compress.js";
import { convertImageTool } from "./tools/convert.js";
import { cropImageTool } from "./tools/crop.js";
import { resizeImageTool } from "./tools/resize.js";
import { getUsageTool } from "./tools/usage.js";
import type { TinifyLikeClient } from "./tools/shared.js";

export const SERVER_NAME = "tinify";
export const SERVER_VERSION = "0.1.0";

export const allTools = [
  compressImageTool,
  resizeImageTool,
  cropImageTool,
  convertImageTool,
  getUsageTool,
] as const;

export function createServer(client: TinifyLikeClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for the Tinify.dev image API: compress, resize, crop, and convert local images, plus account usage. Image paths must be absolute. Results are written as <name>.min.<ext> next to the input unless output_path is given; source files are never overwritten silently.",
    },
  );
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      tool.config as never,
      tool.makeHandler(client) as never,
    );
  }
  return server;
}
