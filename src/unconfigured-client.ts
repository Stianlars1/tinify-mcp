import { MissingApiKeyError, missingApiKeyMessage } from "./config.js";
import type { TinifyLikeClient } from "./tools/shared.js";

/**
 * A client that satisfies the tool interface but cannot talk to the API.
 *
 * Installed when TINIFY_API_KEY is absent so the server still starts, completes
 * the handshake, and advertises its tools. The tools are then discoverable and
 * the reason they cannot run arrives as a tool result - which the MCP client
 * actually renders - rather than as stderr from a process that already exited.
 */
export function createUnconfiguredClient(): TinifyLikeClient {
  const refuse = (): never => {
    throw new MissingApiKeyError(missingApiKeyMessage);
  };
  return {
    compress: refuse,
    resize: refuse,
    crop: refuse,
    convert: refuse,
    usage: refuse,
    download: refuse,
  };
}
