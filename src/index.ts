import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TinifyClient } from "@tinify-dev/client";
import { missingApiKeyMessage, readConfig } from "./config.js";
import { createServer } from "./server.js";
import { createUnconfiguredClient } from "./unconfigured-client.js";

async function main(): Promise<void> {
  const config = readConfig(process.env);

  // A missing key is a setup step, not a crash. Exiting here used to leave MCP
  // clients showing only "failed to start" - the explanation went to stderr on
  // a process that was already gone, which is precisely where nobody looks.
  // Start anyway: the tools stay discoverable and the instruction below is
  // returned from the first tool call, in-band, where the client renders it.
  const client =
    config.apiKey === undefined
      ? createUnconfiguredClient()
      : new TinifyClient({
          apiKey: config.apiKey,
          ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        });

  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the JSON-RPC channel; all logging goes to stderr. Still printed
  // at startup so anyone running the binary in a terminal sees it immediately.
  if (config.apiKey === undefined) {
    console.error(missingApiKeyMessage);
    console.error(
      "\ntinify-mcp: started without a key - tools are listed but will refuse until TINIFY_API_KEY is set.",
    );
  } else {
    console.error("tinify-mcp: ready on stdio (5 tools registered)");
  }
}

main().catch((error: unknown) => {
  console.error(
    "tinify-mcp: fatal:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
