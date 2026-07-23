import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TinifyClient } from "@tinify-dev/client";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Fail fast with a copy-pasteable fix instead of erroring on first use.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const client = new TinifyClient({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
  });
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging goes to stderr.
  console.error("tinify-mcp: ready on stdio (5 tools registered)");
}

main().catch((error: unknown) => {
  console.error(
    "tinify-mcp: fatal:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
