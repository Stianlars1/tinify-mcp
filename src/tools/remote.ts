import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  ImageResultData,
  QualityMode,
  TargetFormat,
} from "@tinify-dev/client";
import {
  changePercent,
  formatBytes,
  SUPPORTED_EXTENSIONS,
  textResult,
  toErrorResult,
  ToolInputError,
  type TextResult,
  type TinifyLikeClient,
} from "./shared.js";
import { FORMAT_EXTENSIONS } from "./convert.js";
import { getUsageTool } from "./usage.js";

/**
 * Remote (streamable-HTTP) variants of the image tools.
 *
 * The stdio tools operate on local filesystem paths, which is meaningless for
 * a hosted server. These tools keep the same five names but accept the image
 * as base64 (`image_base64`, optionally with `filename`) and return the result
 * as base64 in `structuredContent.image_base64`. Nothing is ever read from or
 * written to a filesystem, and no URLs are fetched (no SSRF surface).
 */

/**
 * Maximum DECODED input size for the hosted server: the 40 MB API limit
 * minus base64/JSON transport overhead (base64 inflates bytes by ~4/3).
 */
export const MAX_REMOTE_IMAGE_BYTES = 28 * 1024 * 1024;

export const REMOTE_INSTRUCTIONS =
  "Tools for the Tinify.dev image API over the hosted MCP endpoint: compress, resize, crop, and convert images, plus account usage. Send images as base64 in image_base64 (max ~28 MB decoded; data: URI prefixes are stripped). Results come back as base64 in structuredContent.image_base64 together with a text summary. Nothing is read from or written to any filesystem, and the server never fetches URLs.";

/**
 * Decodes and validates a base64 image payload. Accepts an optional
 * `data:*;base64,` prefix (stripped), rejects invalid base64, and rejects
 * payloads whose decoded size exceeds {@link MAX_REMOTE_IMAGE_BYTES} BEFORE
 * decoding, so oversized inputs fail fast with a clear error.
 */
export function decodeImageBase64(imageBase64: string): Uint8Array {
  let cleaned = imageBase64;
  if (cleaned.startsWith("data:")) {
    const comma = cleaned.indexOf(",");
    if (comma === -1) {
      throw new ToolInputError(
        "image_base64 looks like a data: URI but has no comma; expected data:<mime>;base64,<payload>.",
      );
    }
    cleaned = cleaned.slice(comma + 1);
  }
  cleaned = cleaned.replace(/\s+/g, "");
  if (cleaned.length === 0) {
    throw new ToolInputError("image_base64 is empty.");
  }
  // Size gate first (cheap), so a 100 MB payload is rejected without decoding.
  const estimatedBytes = Math.floor((cleaned.length / 4) * 3);
  if (estimatedBytes > MAX_REMOTE_IMAGE_BYTES) {
    throw new ToolInputError(
      `image_base64 decodes to roughly ${formatBytes(estimatedBytes)}, which exceeds the ` +
        `${formatBytes(MAX_REMOTE_IMAGE_BYTES)} limit for the hosted server (the 40 MB API ` +
        `limit minus base64 transport overhead). For larger files use the stdio server ` +
        `(npx -y @tinify-dev/mcp) or the REST API directly.`,
    );
  }
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new ToolInputError(
      "image_base64 is not valid base64 (standard alphabet, optional = padding, length divisible by 4).",
    );
  }
  return new Uint8Array(Buffer.from(cleaned, "base64"));
}

/** Validates the optional filename: plain name, supported extension if any. */
export function validateRemoteFilename(
  filename: string | undefined,
): string | undefined {
  if (filename === undefined) return undefined;
  const trimmed = filename.trim();
  if (trimmed === "") return undefined;
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new ToolInputError(
      `filename must be a plain file name like "photo.png", not a path (got "${filename}").`,
    );
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot > 0) {
    const ext = trimmed.slice(dot).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new ToolInputError(
        `Unsupported file type "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
      );
    }
  }
  return trimmed;
}

/** Suggested result name: <base>.min.<ext>, with an optional new extension. */
function suggestResultName(
  filename: string | undefined,
  targetExt?: string,
): string | null {
  if (filename === undefined) return null;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = targetExt ?? (dot > 0 ? filename.slice(dot) : "");
  return `${base}.min${ext}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return Buffer.from(await blob.arrayBuffer()).toString("base64");
}

/** Raw structured-content schema shared by the remote image tools. */
export const remoteImageOutputShape = {
  original_bytes: z.number().describe("Input size in bytes."),
  result_bytes: z.number().describe("Result size in bytes."),
  saved_bytes: z.number().describe("original_bytes - result_bytes."),
  change_percent: z
    .number()
    .describe("Byte change in percent; negative means smaller."),
  optimized: z
    .boolean()
    .nullable()
    .describe(
      "false when the API could not shrink the file and returned the original bytes; null when the concept does not apply (resize/crop).",
    ),
  width: z.number().nullable(),
  height: z.number().nullable(),
  image_base64: z
    .string()
    .nullable()
    .describe(
      "Base64 of the result image bytes, or null when the API could not shrink the file (compress only) and the result would be byte-identical to your input.",
    ),
  filename: z
    .string()
    .nullable()
    .describe(
      "Suggested file name for the result (derived from the input filename when given), or null.",
    ),
  request_id: z.string().describe("Quote this when contacting support."),
};

function remoteImageStructuredContent(options: {
  data: ImageResultData;
  requestId: string;
  imageBase64: string | null;
  filename: string | null;
}): Record<string, unknown> {
  const { data, requestId, imageBase64, filename } = options;
  return {
    original_bytes: data.original_bytes,
    result_bytes: data.result_bytes,
    saved_bytes: data.original_bytes - data.result_bytes,
    change_percent: changePercent(data.original_bytes, data.result_bytes),
    optimized: data.optimized,
    width: data.width,
    height: data.height,
    image_base64: imageBase64,
    filename,
    request_id: requestId,
  };
}

const imageBase64Schema = z
  .string()
  .describe(
    "Base64-encoded image bytes (png, jpg, jpeg, webp, avif). Standard base64; a data: URI prefix is tolerated and stripped. Max ~28 MB decoded. URLs are NOT accepted - this server never fetches remote content.",
  );

const filenameSchema = z
  .string()
  .describe(
    'Optional plain file name for the input, e.g. "photo.png". Used for format hints and to suggest a result name.',
  );

const qualityModeSchema = z
  .enum(["balanced", "best_quality", "lossless"])
  .describe(
    "balanced (default), best_quality, or lossless. lossless is rejected for JPEG inputs.",
  );

export interface RemoteCompressImageArgs {
  image_base64: string;
  filename?: string;
  quality_mode?: QualityMode;
  target_size_kb?: number;
}

export const remoteCompressImageTool = {
  name: "compress_image",
  config: {
    title: "Compress image",
    description:
      "Compress a PNG, JPEG, WebP, or AVIF image with Tinify.dev. Send the image as base64 (image_base64, max ~28 MB decoded); the result comes back as base64 in structuredContent.image_base64 plus a text summary with byte counts. Nothing is written to disk. The API never returns more bytes than it received; when it cannot shrink the file the tool says so honestly (optimized: false) and returns no image bytes instead of a byte-identical copy.",
    inputSchema: {
      image_base64: imageBase64Schema,
      filename: filenameSchema.optional(),
      quality_mode: qualityModeSchema.optional(),
      target_size_kb: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Aim for a result at or below this many kilobytes (beta; server rollout).",
        ),
    },
    outputSchema: remoteImageOutputShape,
    annotations: {
      title: "Compress image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: RemoteCompressImageArgs): Promise<TextResult> => {
      try {
        const bytes = decodeImageBase64(args.image_base64);
        const filename = validateRemoteFilename(args.filename);
        const result = await client.compress(bytes, {
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          ...(args.target_size_kb !== undefined
            ? { target_size_bytes: args.target_size_kb * 1024 }
            : {}),
          ...(filename !== undefined ? { filename } : {}),
        });
        const data = result.data;

        if (data.optimized === false) {
          // Honest no-op: the API returned the original bytes, so shipping
          // them back as "the result" would just duplicate your input.
          return textResult(
            `${filename ?? "The image"} is already as small as Tinify.dev can make it ` +
              `(${formatBytes(data.original_bytes)}). The API returned the original bytes ` +
              `(optimized: false), so no image_base64 is returned - keep your input.`,
            remoteImageStructuredContent({
              data,
              requestId: result.requestId,
              imageBase64: null,
              filename: null,
            }),
          );
        }

        const blob = await client.download(result);
        const imageBase64 = await blobToBase64(blob);
        const pct = changePercent(data.original_bytes, data.result_bytes);
        return textResult(
          `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} (${pct}%). ` +
            `Result returned as base64 in structuredContent.image_base64 ` +
            `(${formatBytes(data.result_bytes)} decoded).`,
          remoteImageStructuredContent({
            data,
            requestId: result.requestId,
            imageBase64,
            filename: suggestResultName(filename),
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteResizeImageArgs {
  image_base64: string;
  filename?: string;
  width?: number;
  height?: number;
  scale?: number;
  keep_aspect_ratio?: boolean;
}

export const remoteResizeImageTool = {
  name: "resize_image",
  config: {
    title: "Resize image",
    description:
      "Resize a PNG, JPEG, WebP, or AVIF image with Tinify.dev by width, height, or scale. Send the image as base64 (image_base64, max ~28 MB decoded); the result comes back as base64 in structuredContent.image_base64. At least one of width, height, or scale is required. Nothing is written to disk.",
    inputSchema: {
      image_base64: imageBase64Schema,
      filename: filenameSchema.optional(),
      width: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target width in pixels."),
      height: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target height in pixels."),
      scale: z
        .number()
        .positive()
        .optional()
        .describe("Scale factor, e.g. 0.5 halves both dimensions."),
      keep_aspect_ratio: z.boolean().optional(),
    },
    outputSchema: remoteImageOutputShape,
    annotations: {
      title: "Resize image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: RemoteResizeImageArgs): Promise<TextResult> => {
      try {
        if (
          args.width === undefined &&
          args.height === undefined &&
          args.scale === undefined
        ) {
          throw new ToolInputError(
            "resize_image needs at least one of width, height, or scale.",
          );
        }
        const bytes = decodeImageBase64(args.image_base64);
        const filename = validateRemoteFilename(args.filename);
        const result = await client.resize(bytes, {
          ...(args.width !== undefined ? { width: args.width } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
          ...(args.keep_aspect_ratio !== undefined
            ? { keep_aspect_ratio: args.keep_aspect_ratio }
            : {}),
          ...(filename !== undefined ? { filename } : {}),
        });
        const data = result.data;
        const blob = await client.download(result);
        const imageBase64 = await blobToBase64(blob);
        const dims =
          data.width !== null && data.height !== null
            ? ` (${data.width}x${data.height})`
            : "";
        return textResult(
          `Resized ${filename ?? "image"}${dims}: ` +
            `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%). ` +
            `Result returned as base64 in structuredContent.image_base64.`,
          remoteImageStructuredContent({
            data,
            requestId: result.requestId,
            imageBase64,
            filename: suggestResultName(filename),
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteCropImageArgs {
  image_base64: string;
  filename?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const remoteCropImageTool = {
  name: "crop_image",
  config: {
    title: "Crop image",
    description:
      "Crop a PNG, JPEG, WebP, or AVIF image with Tinify.dev to the given rectangle. Send the image as base64 (image_base64, max ~28 MB decoded); the result comes back as base64 in structuredContent.image_base64. Nothing is written to disk.",
    inputSchema: {
      image_base64: imageBase64Schema,
      filename: filenameSchema.optional(),
      x: z
        .number()
        .int()
        .nonnegative()
        .describe("Left edge of the crop rectangle in pixels."),
      y: z
        .number()
        .int()
        .nonnegative()
        .describe("Top edge of the crop rectangle in pixels."),
      width: z.number().int().positive().describe("Crop width in pixels."),
      height: z.number().int().positive().describe("Crop height in pixels."),
    },
    outputSchema: remoteImageOutputShape,
    annotations: {
      title: "Crop image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: RemoteCropImageArgs): Promise<TextResult> => {
      try {
        const bytes = decodeImageBase64(args.image_base64);
        const filename = validateRemoteFilename(args.filename);
        const result = await client.crop(bytes, {
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          ...(filename !== undefined ? { filename } : {}),
        });
        const data = result.data;
        const blob = await client.download(result);
        const imageBase64 = await blobToBase64(blob);
        return textResult(
          `Cropped ${filename ?? "image"} to ${args.width}x${args.height}` +
            `+${args.x}+${args.y}: ${formatBytes(data.original_bytes)} → ` +
            `${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%). ` +
            `Result returned as base64 in structuredContent.image_base64.`,
          remoteImageStructuredContent({
            data,
            requestId: result.requestId,
            imageBase64,
            filename: suggestResultName(filename),
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteConvertImageArgs {
  image_base64: string;
  filename?: string;
  format: TargetFormat;
  quality_mode?: QualityMode;
}

export const remoteConvertImageTool = {
  name: "convert_image",
  config: {
    title: "Convert image format",
    description:
      "Convert an image to AVIF, WebP, JPEG, or PNG with Tinify.dev (beta endpoint; may not be enabled on every account yet). Send the image as base64 (image_base64, max ~28 MB decoded); the result comes back as base64 in structuredContent.image_base64. Converting to the same format is rejected by the API (same_format_conversion). Nothing is written to disk.",
    inputSchema: {
      image_base64: imageBase64Schema,
      filename: filenameSchema.optional(),
      format: z
        .enum(["avif", "webp", "jpeg", "png"])
        .describe("Target format."),
      quality_mode: qualityModeSchema.optional(),
    },
    outputSchema: remoteImageOutputShape,
    annotations: {
      title: "Convert image format",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: RemoteConvertImageArgs): Promise<TextResult> => {
      try {
        const bytes = decodeImageBase64(args.image_base64);
        const filename = validateRemoteFilename(args.filename);
        const result = await client.convert(bytes, {
          format: args.format,
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          ...(filename !== undefined ? { filename } : {}),
        });
        const data = result.data;
        const blob = await client.download(result);
        const imageBase64 = await blobToBase64(blob);
        return textResult(
          `Converted ${filename ?? "image"} to ${args.format}: ` +
            `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%). ` +
            `Result returned as base64 in structuredContent.image_base64.`,
          remoteImageStructuredContent({
            data,
            requestId: result.requestId,
            imageBase64,
            filename: suggestResultName(filename, FORMAT_EXTENSIONS[args.format]),
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

/**
 * The remote toolset: same five names as the stdio server, but base64 in and
 * base64 out. get_usage is byte-for-byte the stdio tool.
 */
export const remoteTools = [
  remoteCompressImageTool,
  remoteResizeImageTool,
  remoteCropImageTool,
  remoteConvertImageTool,
  getUsageTool,
] as const;
