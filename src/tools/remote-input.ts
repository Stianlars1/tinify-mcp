import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MAX_FILE_BYTES } from "@tinify-dev/client";
import { z } from "zod";
import { formatBytes, ToolInputError } from "./shared.js";

const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

/**
 * Exact ChatGPT file object contract. All four properties must be declared;
 * only download_url and file_id are required.
 */
export const openAIFileSchema = z
  .object({
    download_url: z
      .string()
      .describe("Temporary HTTPS URL supplied by ChatGPT for this file."),
    file_id: z.string().describe("ChatGPT file identifier."),
    mime_type: z
      .string()
      .optional()
      .describe("File MIME type when available."),
    file_name: z.string().optional().describe("Original file name when available."),
  })
  .strict();

export interface OpenAIFileInput {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export interface RemoteFileOptions {
  /** Injectable for deterministic tests; defaults to the platform fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for deterministic tests; defaults to node:dns lookup. */
  resolveHostname?: HostnameResolver;
  timeoutMs?: number;
}

async function defaultResolveHostname(
  hostname: string,
): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const prefix = "::ffff:";
  if (!lower.startsWith(prefix)) return null;
  const suffix = lower.slice(prefix.length);
  if (isIP(suffix) === 4) return suffix;
  const halves = suffix.split(":");
  if (halves.length !== 2) return null;
  const high = Number.parseInt(halves[0] ?? "", 16);
  const low = Number.parseInt(halves[1] ?? "", 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0] ?? "";
  const mapped = mappedIpv4(lower);
  if (mapped !== null) return isPublicIpv4(mapped);
  if (lower === "::" || lower === "::1") return false;
  if (/^f[cd]/.test(lower)) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  if (lower.startsWith("ff")) return false;
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return false;
  return true;
}

/** Exported for focused security regression tests. */
export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

async function validateDownloadUrl(
  rawUrl: string,
  resolveHostname: HostnameResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolInputError(
      "The attached file has an invalid download_url. Attach the image again and retry.",
    );
  }
  if (url.protocol !== "https:") {
    throw new ToolInputError(
      "The attached file download_url must use HTTPS.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ToolInputError(
      "The attached file download_url must not contain embedded credentials.",
    );
  }

  const rawHostname = url.hostname.toLowerCase();
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new ToolInputError(
      "The attached file download_url resolves to a non-public host.",
    );
  }

  const literalVersion = isIP(hostname);
  let addresses: readonly string[];
  try {
    addresses =
      literalVersion === 0 ? await resolveHostname(hostname) : [hostname];
  } catch {
    throw new ToolInputError(
      "The attached file download_url host could not be resolved.",
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIpAddress(address))
  ) {
    throw new ToolInputError(
      "The attached file download_url resolves to a private or reserved address.",
    );
  }
  return url;
}

function validateMimeType(mimeType: string | undefined): void {
  if (
    mimeType !== undefined &&
    mimeType !== "" &&
    !ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
  ) {
    throw new ToolInputError(
      `Unsupported attached file type "${mimeType}". Supported: PNG, JPEG, WebP, AVIF.`,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new ToolInputError(
        `The attached image is ${formatBytes(parsedLength)}, which exceeds the 40 MB API limit.`,
      );
    }
  }
  if (response.body === null) {
    throw new ToolInputError("The attached file download returned no body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ToolInputError(
          `The attached image exceeds the 40 MB API limit (${maxBytes} bytes).`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new ToolInputError("The attached image is empty.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Downloads a ChatGPT-provided attachment without accepting arbitrary server
 * fetches: HTTPS only, public DNS only, no redirects, timeout, and a 40 MB cap.
 */
export async function downloadOpenAIFile(
  file: OpenAIFileInput,
  options: RemoteFileOptions = {},
): Promise<Uint8Array> {
  validateMimeType(file.mime_type);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resolveHostname =
    options.resolveHostname ?? defaultResolveHostname;
  const url = await validateDownloadUrl(file.download_url, resolveHostname);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(
        options.timeoutMs ?? FILE_DOWNLOAD_TIMEOUT_MS,
      ),
      headers: { Accept: "image/png,image/jpeg,image/webp,image/avif" },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new ToolInputError(
        "Downloading the attached image timed out. Attach it again and retry.",
      );
    }
    throw new ToolInputError(
      `Could not download the attached image: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new ToolInputError(
      `Could not download the attached image (HTTP ${response.status}). Attach it again and retry.`,
    );
  }

  const responseMimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  validateMimeType(
    responseMimeType === "application/octet-stream"
      ? undefined
      : responseMimeType,
  );
  return readBoundedBody(response, MAX_FILE_BYTES);
}
