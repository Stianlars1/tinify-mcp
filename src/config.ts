export interface McpConfig {
  apiKey: string;
  baseUrl?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MISSING_KEY_MESSAGE = [
  "tinify-mcp: TINIFY_API_KEY is not set.",
  "",
  "This MCP server needs a Tinify.dev API key to talk to the API.",
  "Create one (free, 500 operations/month) at https://tinify.dev/developers",
  "and pass it as an environment variable, e.g. for Claude Desktop:",
  "",
  '  "mcpServers": {',
  '    "tinify": {',
  '      "command": "npx",',
  '      "args": ["-y", "@tinify-dev/mcp"],',
  '      "env": { "TINIFY_API_KEY": "tnf_live_..." }',
  "    }",
  "  }",
  "",
  "or with the Claude Code CLI:",
  "",
  "  claude mcp add tinify -e TINIFY_API_KEY=tnf_live_... -- npx -y @tinify-dev/mcp",
].join("\n");

/**
 * Reads configuration from the environment. Throws a {@link ConfigError}
 * with a copy-pasteable fix when the API key is missing.
 */
export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const apiKey = env["TINIFY_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new ConfigError(MISSING_KEY_MESSAGE);
  }
  const baseUrl = env["TINIFY_BASE_URL"];
  return baseUrl !== undefined && baseUrl !== ""
    ? { apiKey, baseUrl }
    : { apiKey };
}
