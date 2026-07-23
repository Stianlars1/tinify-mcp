import { stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  MAX_FILE_BYTES,
  TinifyApiError,
  TinifyError,
  type CompressOptions,
  type ConvertOptions,
  type CropOptions,
  type ImageResultData,
  type ResizeOptions,
  type TinifyResponse,
  type Usage,
} from "@tinify-dev/client";

/** The subset of the SDK client the tools use; tests inject a fake. */
export interface TinifyLikeClient {
  compress(
    input: Uint8Array,
    options?: CompressOptions & { filename?: string },
  ): Promise<TinifyResponse<ImageResultData>>;
  resize(
    input: Uint8Array,
    options?: ResizeOptions & { filename?: string },
  ): Promise<TinifyResponse<ImageResultData>>;
  crop(
    input: Uint8Array,
    options: CropOptions & { filename?: string },
  ): Promise<TinifyResponse<ImageResultData>>;
  convert(
    input: Uint8Array,
    options: ConvertOptions & { filename?: string },
  ): Promise<TinifyResponse<ImageResultData>>;
  usage(): Promise<TinifyResponse<Usage>>;
  download(resultOrUrl: TinifyResponse<ImageResultData>): Promise<Blob>;
}

export interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const SUPPORTED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
] as const;

export class ToolInputError extends Error {}

/**
 * Validates an input image path: absolute, exists, supported extension,
 * and at most 40 MB (the API limit — checked here to fail fast).
 */
export async function validateInputPath(
  inputPath: string,
): Promise<{ sizeBytes: number; ext: string }> {
  if (!path.isAbsolute(inputPath)) {
    throw new ToolInputError(
      `path must be absolute, got "${inputPath}". MCP servers run with an unpredictable working directory, so relative paths are ambiguous.`,
    );
  }
  let stats;
  try {
    stats = await stat(inputPath);
  } catch {
    throw new ToolInputError(`File not found: ${inputPath}`);
  }
  if (!stats.isFile()) {
    throw new ToolInputError(`Not a file: ${inputPath}`);
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ToolInputError(
      `Unsupported file type "${ext || "(none)"}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new ToolInputError(
      `${inputPath} is ${formatBytes(stats.size)}, which exceeds the 40 MB API limit (${MAX_FILE_BYTES} bytes).`,
    );
  }
  return { sizeBytes: stats.size, ext };
}

/**
 * Resolves where a result should be written.
 *
 * - Default: `<name>.min.<ext>` next to the input (never collides with the
 *   source).
 * - An explicit `output_path` must be absolute.
 * - Writing over the SOURCE image requires BOTH `output_path` pointing at it
 *   AND `overwrite: true` — it never happens silently.
 * - Overwriting any other existing file requires `overwrite: true`.
 */
export function resolveOutputPath(options: {
  inputPath: string;
  outputPath?: string | undefined;
  overwrite: boolean;
  /** Extension override for convert (e.g. ".webp"). Includes the dot. */
  targetExt?: string;
}): string {
  const { inputPath, outputPath, overwrite, targetExt } = options;
  let resolved: string;
  if (outputPath !== undefined) {
    if (!path.isAbsolute(outputPath)) {
      throw new ToolInputError(
        `output_path must be absolute, got "${outputPath}".`,
      );
    }
    resolved = outputPath;
  } else {
    const ext = targetExt ?? path.extname(inputPath);
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    resolved = path.join(dir, `${base}.min${ext}`);
  }
  if (path.resolve(resolved) === path.resolve(inputPath)) {
    if (!overwrite) {
      throw new ToolInputError(
        `Refusing to overwrite the source image ${inputPath}. Pass overwrite: true (with output_path set to the source) if you really want to replace it, or omit output_path to write ${suggestDefault(inputPath, targetExt)} instead.`,
      );
    }
    return resolved;
  }
  if (existsSync(resolved) && !overwrite) {
    throw new ToolInputError(
      `${resolved} already exists. Pass overwrite: true to replace it, or choose a different output_path.`,
    );
  }
  return resolved;
}

function suggestDefault(inputPath: string, targetExt?: string): string {
  const ext = targetExt ?? path.extname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(path.dirname(inputPath), `${base}.min${ext}`);
}

export async function writeResult(
  outputPath: string,
  blob: Blob,
): Promise<void> {
  await writeFile(outputPath, new Uint8Array(await blob.arrayBuffer()));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Percent change, negative = smaller. E.g. -68.9 for a 68.9% reduction. */
export function changePercent(originalBytes: number, resultBytes: number): number {
  if (originalBytes === 0) return 0;
  return Number((((resultBytes - originalBytes) / originalBytes) * 100).toFixed(1));
}

export function textResult(
  text: string,
  structuredContent: Record<string, unknown>,
): TextResult {
  return { content: [{ type: "text", text }], structuredContent };
}

export function errorResult(text: string): TextResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Maps any thrown error to an honest, actionable isError result. */
export function toErrorResult(error: unknown): TextResult {
  if (error instanceof ToolInputError) {
    return errorResult(error.message);
  }
  if (error instanceof TinifyApiError) {
    const retry =
      error.retryAfter !== undefined
        ? ` Retry after ${error.retryAfter}s.`
        : "";
    return errorResult(
      `Tinify.dev API error ${error.code} (HTTP ${error.status}): ${error.message}${retry} Quote request_id ${error.requestId} when contacting support.`,
    );
  }
  if (error instanceof TinifyError) {
    return errorResult(`Tinify.dev client error: ${error.message}`);
  }
  return errorResult(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Shared structured-content shape for image results (raw numbers only). */
export function imageStructuredContent(options: {
  data: ImageResultData;
  requestId: string;
  outputPath: string | null;
  wrote: boolean;
}): Record<string, unknown> {
  const { data, requestId, outputPath, wrote } = options;
  return {
    original_bytes: data.original_bytes,
    result_bytes: data.result_bytes,
    saved_bytes: data.original_bytes - data.result_bytes,
    change_percent: changePercent(data.original_bytes, data.result_bytes),
    optimized: data.optimized,
    width: data.width,
    height: data.height,
    output_path: outputPath,
    wrote,
    request_id: requestId,
  };
}
