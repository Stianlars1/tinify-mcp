import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  ImageResultData,
  QualityMode,
  TargetFormat,
  TinifyResponse,
} from "@tinify-dev/client";
import { TINIFY_OAUTH_SCOPES } from "../auth-shared.js";
import {
  changePercent,
  DOWNLOAD_TIMEOUT_MS,
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
import {
  downloadOpenAIFile,
  openAIFileSchema,
  type OpenAIFileInput,
  type RemoteFileOptions,
} from "./remote-input.js";

/**
 * Remote (streamable-HTTP) variants of the image tools.
 *
 * The stdio tools operate on local filesystem paths, which is meaningless for
 * a hosted server. These tools keep the same five names but accept the image
 * through either a ChatGPT file attachment (`image`) or portable base64
 * (`image_base64`). ChatGPT receives an expiring result link; legacy base64
 * callers continue to receive result bytes in structuredContent.
 */

/**
 * Maximum DECODED input size for the hosted server: the 40 MB API limit
 * minus base64/JSON transport overhead (base64 inflates bytes by ~4/3).
 */
export const MAX_REMOTE_IMAGE_BYTES = 28 * 1024 * 1024;

export const REMOTE_INSTRUCTIONS =
  "Tools for the Tinify.dev image API over the hosted MCP endpoint: compress, resize, crop, and convert images, plus account usage. In ChatGPT, attach one PNG, JPEG, WebP, or AVIF file in image. Other MCP clients may send image_base64 (max ~28 MB decoded). Provide exactly one image source. Successful image calls return byte metrics and a temporary result download link; base64 callers also receive structuredContent.image_base64 for backwards compatibility. Nothing is read from or written to a filesystem.";

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

const remoteOAuthSecuritySchemes = [
  { type: "oauth2", scopes: [...TINIFY_OAUTH_SCOPES] },
] as const;

function remoteToolMeta(options: {
  invoking: string;
  invoked: string;
  acceptsFile: boolean;
}): Record<string, unknown> {
  return {
    // OpenAI requires the auth policy per tool. The current MCP TypeScript SDK
    // exposes extension metadata through _meta, which is also the documented
    // compatibility location read by ChatGPT.
    securitySchemes: remoteOAuthSecuritySchemes,
    ...(options.acceptsFile ? { "openai/fileParams": ["image"] } : {}),
    "openai/toolInvocation/invoking": options.invoking,
    "openai/toolInvocation/invoked": options.invoked,
  };
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
      "Base64 result bytes for legacy image_base64 callers. Null for ChatGPT file calls or when compression returns an unchanged input.",
    ),
  download_url: z
    .string()
    .nullable()
    .describe(
      "Temporary HTTPS result link, or null when compression returned an unchanged input.",
    ),
  expires_at: z
    .string()
    .nullable()
    .describe("Expiry timestamp for download_url, or null when no result link is returned."),
  mime_type: z.string().nullable().describe("Result image MIME type."),
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
  downloadUrl: string | null;
  expiresAt: string | null;
  mimeType: string | null;
}): Record<string, unknown> {
  const {
    data,
    requestId,
    imageBase64,
    filename,
    downloadUrl,
    expiresAt,
    mimeType,
  } = options;
  return {
    original_bytes: data.original_bytes,
    result_bytes: data.result_bytes,
    saved_bytes: data.original_bytes - data.result_bytes,
    change_percent: changePercent(data.original_bytes, data.result_bytes),
    optimized: data.optimized,
    width: data.width,
    height: data.height,
    image_base64: imageBase64,
    download_url: downloadUrl,
    expires_at: expiresAt,
    mime_type: mimeType,
    filename,
    request_id: requestId,
  };
}

const imageBase64Schema = z
  .string()
  .describe(
    "Base64-encoded image bytes (png, jpg, jpeg, webp, avif). Standard base64; a data: URI prefix is tolerated and stripped. Max ~28 MB decoded. Do not put a URL in this field.",
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

interface RemoteImageSourceArgs {
  image?: OpenAIFileInput;
  image_base64?: string;
  filename?: string;
}

interface ResolvedRemoteImage {
  bytes: Uint8Array;
  filename: string | undefined;
  includeBase64Result: boolean;
}

async function resolveRemoteImage(
  args: RemoteImageSourceArgs,
  fileOptions: RemoteFileOptions,
): Promise<ResolvedRemoteImage> {
  const hasFile = args.image !== undefined;
  const hasBase64 = args.image_base64 !== undefined;
  if (hasFile === hasBase64) {
    throw new ToolInputError(
      "Provide exactly one image source: attach a file in image, or send image_base64.",
    );
  }

  const filename = validateRemoteFilename(
    args.filename ?? args.image?.file_name,
  );
  if (args.image !== undefined) {
    return {
      bytes: await downloadOpenAIFile(args.image, fileOptions),
      filename,
      includeBase64Result: false,
    };
  }
  return {
    bytes: decodeImageBase64(args.image_base64 as string),
    filename,
    includeBase64Result: true,
  };
}

function mimeTypeForFilename(filename: string | null): string | null {
  if (filename === null) return null;
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

function extensionForFormat(format: string | undefined): string | null {
  switch (format?.toLowerCase()) {
    case "png":
      return ".png";
    case "jpg":
    case "jpeg":
      return ".jpg";
    case "webp":
      return ".webp";
    case "avif":
      return ".avif";
    default:
      return null;
  }
}

async function deliverRemoteImage(options: {
  client: TinifyLikeClient;
  result: TinifyResponse<ImageResultData>;
  filename: string | undefined;
  targetExt?: string;
  includeBase64Result: boolean;
  summary: string;
}): Promise<TextResult> {
  const {
    client,
    result,
    filename,
    targetExt,
    includeBase64Result,
    summary,
  } = options;
  const inferredExt =
    targetExt ?? extensionForFormat(result.data.result_format) ?? undefined;
  const resultFilename =
    suggestResultName(filename, inferredExt) ??
    `tinify-result${inferredExt ?? ""}`;
  const mimeType = mimeTypeForFilename(resultFilename);
  let imageBase64: string | null = null;
  if (includeBase64Result) {
    const blob = await client.download(result, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    imageBase64 = await blobToBase64(blob);
  }

  const delivery = includeBase64Result
    ? "Result bytes are also available in structuredContent.image_base64."
    : `Download ${resultFilename} before ${result.data.expires_at}.`;
  return {
    content: [
      { type: "text", text: `${summary} ${delivery}` },
      {
        type: "resource_link",
        uri: result.data.download_url,
        name: resultFilename,
        description: "Temporary Tinify.dev result image (deleted after expiry).",
        ...(mimeType !== null ? { mimeType } : {}),
        size: result.data.result_bytes,
      },
    ],
    structuredContent: remoteImageStructuredContent({
      data: result.data,
      requestId: result.requestId,
      imageBase64,
      filename: resultFilename,
      downloadUrl: result.data.download_url,
      expiresAt: result.data.expires_at,
      mimeType,
    }),
  };
}

export interface RemoteCompressImageArgs {
  image?: OpenAIFileInput;
  image_base64?: string;
  filename?: string;
  quality_mode?: QualityMode;
  target_size_kb?: number;
}

export const remoteCompressImageTool = {
  name: "compress_image",
  config: {
    title: "Compress image",
    description:
      "Compress one attached PNG, JPEG, WebP, or AVIF image with Tinify.dev. In ChatGPT use image; other MCP clients may use image_base64 (max ~28 MB decoded). This uses one private account operation and returns exact byte savings plus a temporary result download link. Nothing is written to the user's filesystem. When Tinify cannot shrink the image, optimized is false and no duplicate result is returned.",
    inputSchema: {
      image: openAIFileSchema
        .optional()
        .describe("Image file attached in ChatGPT. Use exactly one of image or image_base64."),
      image_base64: imageBase64Schema
        .optional()
        .describe("Portable fallback. Use exactly one of image or image_base64."),
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
    _meta: remoteToolMeta({
      invoking: "Compressing image…",
      invoked: "Image compressed",
      acceptsFile: true,
    }),
  },
  makeHandler(
    client: TinifyLikeClient,
    fileOptions: RemoteFileOptions = {},
  ) {
    return async (args: RemoteCompressImageArgs): Promise<TextResult> => {
      try {
        const input = await resolveRemoteImage(args, fileOptions);
        const result = await client.compress(input.bytes, {
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          ...(args.target_size_kb !== undefined
            ? { target_size_bytes: args.target_size_kb * 1024 }
            : {}),
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        const data = result.data;

        if (data.optimized === false) {
          // Honest no-op: the API returned the original bytes, so shipping
          // them back as "the result" would just duplicate your input.
          return textResult(
            `${input.filename ?? "The image"} is already as small as Tinify.dev can make it ` +
              `(${formatBytes(data.original_bytes)}). The API returned the original bytes ` +
              `(optimized: false), so no duplicate result is returned - keep your input.`,
            remoteImageStructuredContent({
              data,
              requestId: result.requestId,
              imageBase64: null,
              filename: null,
              downloadUrl: null,
              expiresAt: null,
              mimeType: mimeTypeForFilename(input.filename ?? null),
            }),
          );
        }

        const pct = changePercent(data.original_bytes, data.result_bytes);
        return deliverRemoteImage({
          client,
          result,
          filename: input.filename,
          includeBase64Result: input.includeBase64Result,
          summary: `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} (${pct}%).`,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteResizeImageArgs {
  image?: OpenAIFileInput;
  image_base64?: string;
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
      "Resize one attached PNG, JPEG, WebP, or AVIF image with Tinify.dev by width, height, or scale. In ChatGPT use image; other MCP clients may use image_base64. This uses one private account operation and returns dimensions, byte metrics, and a temporary result download link. At least one of width, height, or scale is required.",
    inputSchema: {
      image: openAIFileSchema
        .optional()
        .describe("Image file attached in ChatGPT. Use exactly one of image or image_base64."),
      image_base64: imageBase64Schema
        .optional()
        .describe("Portable fallback. Use exactly one of image or image_base64."),
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
    _meta: remoteToolMeta({
      invoking: "Resizing image…",
      invoked: "Image resized",
      acceptsFile: true,
    }),
  },
  makeHandler(
    client: TinifyLikeClient,
    fileOptions: RemoteFileOptions = {},
  ) {
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
        const input = await resolveRemoteImage(args, fileOptions);
        const result = await client.resize(input.bytes, {
          ...(args.width !== undefined ? { width: args.width } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
          ...(args.keep_aspect_ratio !== undefined
            ? { keep_aspect_ratio: args.keep_aspect_ratio }
            : {}),
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        const data = result.data;
        const dims =
          data.width !== null && data.height !== null
            ? ` (${data.width}x${data.height})`
            : "";
        return deliverRemoteImage({
          client,
          result,
          filename: input.filename,
          includeBase64Result: input.includeBase64Result,
          summary:
            `Resized ${input.filename ?? "image"}${dims}: ` +
            `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%).`,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteCropImageArgs {
  image?: OpenAIFileInput;
  image_base64?: string;
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
      "Crop one attached PNG, JPEG, WebP, or AVIF image with Tinify.dev to an exact pixel rectangle. In ChatGPT use image; other MCP clients may use image_base64. This uses one private account operation and returns byte metrics plus a temporary result download link.",
    inputSchema: {
      image: openAIFileSchema
        .optional()
        .describe("Image file attached in ChatGPT. Use exactly one of image or image_base64."),
      image_base64: imageBase64Schema
        .optional()
        .describe("Portable fallback. Use exactly one of image or image_base64."),
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
    _meta: remoteToolMeta({
      invoking: "Cropping image…",
      invoked: "Image cropped",
      acceptsFile: true,
    }),
  },
  makeHandler(
    client: TinifyLikeClient,
    fileOptions: RemoteFileOptions = {},
  ) {
    return async (args: RemoteCropImageArgs): Promise<TextResult> => {
      try {
        const input = await resolveRemoteImage(args, fileOptions);
        const result = await client.crop(input.bytes, {
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        const data = result.data;
        return deliverRemoteImage({
          client,
          result,
          filename: input.filename,
          includeBase64Result: input.includeBase64Result,
          summary:
            `Cropped ${input.filename ?? "image"} to ${args.width}x${args.height}` +
            `+${args.x}+${args.y}: ${formatBytes(data.original_bytes)} → ` +
            `${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%).`,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

export interface RemoteConvertImageArgs {
  image?: OpenAIFileInput;
  image_base64?: string;
  filename?: string;
  format: TargetFormat;
  quality_mode?: QualityMode;
}

export const remoteConvertImageTool = {
  name: "convert_image",
  config: {
    title: "Convert image format",
    description:
      "Convert one attached image to AVIF, WebP, JPEG, or PNG with Tinify.dev (beta endpoint; may not be enabled on every account). In ChatGPT use image; other MCP clients may use image_base64. This uses one private account operation and returns byte metrics plus a temporary result download link. Same-format conversion is rejected.",
    inputSchema: {
      image: openAIFileSchema
        .optional()
        .describe("Image file attached in ChatGPT. Use exactly one of image or image_base64."),
      image_base64: imageBase64Schema
        .optional()
        .describe("Portable fallback. Use exactly one of image or image_base64."),
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
    _meta: remoteToolMeta({
      invoking: "Converting image…",
      invoked: "Image converted",
      acceptsFile: true,
    }),
  },
  makeHandler(
    client: TinifyLikeClient,
    fileOptions: RemoteFileOptions = {},
  ) {
    return async (args: RemoteConvertImageArgs): Promise<TextResult> => {
      try {
        const input = await resolveRemoteImage(args, fileOptions);
        const result = await client.convert(input.bytes, {
          format: args.format,
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        const data = result.data;
        return deliverRemoteImage({
          client,
          result,
          filename: input.filename,
          targetExt: FORMAT_EXTENSIONS[args.format],
          includeBase64Result: input.includeBase64Result,
          summary:
            `Converted ${input.filename ?? "image"} to ${args.format}: ` +
            `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%).`,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};

/**
 * The remote toolset keeps the same five names as the stdio server. Image tools
 * accept ChatGPT file objects and a legacy base64 fallback.
 */
function remoteUsageTool() {
  return {
    ...getUsageTool,
    config: {
      ...getUsageTool.config,
      _meta: remoteToolMeta({
        invoking: "Checking usage…",
        invoked: "Usage ready",
        acceptsFile: false,
      }),
    },
  };
}

export function createRemoteTools(fileOptions: RemoteFileOptions = {}) {
  return [
    {
      ...remoteCompressImageTool,
      makeHandler: (client: TinifyLikeClient) =>
        remoteCompressImageTool.makeHandler(client, fileOptions),
    },
    {
      ...remoteResizeImageTool,
      makeHandler: (client: TinifyLikeClient) =>
        remoteResizeImageTool.makeHandler(client, fileOptions),
    },
    {
      ...remoteCropImageTool,
      makeHandler: (client: TinifyLikeClient) =>
        remoteCropImageTool.makeHandler(client, fileOptions),
    },
    {
      ...remoteConvertImageTool,
      makeHandler: (client: TinifyLikeClient) =>
        remoteConvertImageTool.makeHandler(client, fileOptions),
    },
    remoteUsageTool(),
  ] as const;
}

export const remoteTools = createRemoteTools();
