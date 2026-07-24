import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { QualityMode } from "@tinify-dev/client";
import {
  changePercent,
  formatBytes,
  imageStructuredContent,
  resolveOutputPath,
  textResult,
  toErrorResult,
  validateInputPath,
  writeResult,
  type TextResult,
  type TinifyLikeClient,
} from "./shared.js";

/** Raw structured-content schema shared by every image tool. */
export const imageOutputShape = {
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
  output_path: z
    .string()
    .nullable()
    .describe("Where the result was written, or null when nothing was written."),
  wrote: z.boolean().describe("Whether a file was written."),
  request_id: z.string().describe("Quote this when contacting support."),
};

const qualityModeSchema = z
  .enum(["balanced", "best_quality", "lossless"])
  .describe(
    "balanced (default), best_quality, or lossless. lossless is rejected for JPEG inputs.",
  );

export const pathSchema = z
  .string()
  .describe("Absolute path to the image (png, jpg, jpeg, webp, avif; max 40 MB).");

export const outputPathSchema = z
  .string()
  .describe(
    "Absolute path to write the result. Default: <name>.min.<ext> next to the input. The source image is never overwritten unless output_path points at it AND overwrite is true.",
  );

export const overwriteSchema = z
  .boolean()
  .describe("Allow replacing an existing file at the output path. Default false.");

export interface CompressImageArgs {
  path: string;
  output_path?: string;
  quality_mode?: QualityMode;
  target_size_kb?: number;
  overwrite?: boolean;
}

export const compressImageTool = {
  name: "compress_image",
  config: {
    title: "Compress image",
    description:
      "Compress a PNG, JPEG, WebP, or AVIF image with Tinify.dev and write the smaller file next to the original (or to output_path). The API never returns more bytes than it received; when it cannot shrink the file the tool says so honestly (optimized: false) instead of pretending.",
    inputSchema: {
      path: pathSchema,
      output_path: outputPathSchema.optional(),
      quality_mode: qualityModeSchema.optional(),
      target_size_kb: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Aim for a result at or below this many kilobytes (beta; server rollout).",
        ),
      overwrite: overwriteSchema.optional(),
    },
    outputSchema: imageOutputShape,
    annotations: {
      title: "Compress image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: CompressImageArgs): Promise<TextResult> => {
      try {
        await validateInputPath(args.path);
        const overwrite = args.overwrite ?? false;
        const outputPath = resolveOutputPath({
          inputPath: args.path,
          outputPath: args.output_path,
          overwrite,
        });
        const bytes = new Uint8Array(await readFile(args.path));
        const result = await client.compress(bytes, {
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          ...(args.target_size_kb !== undefined
            ? { target_size_bytes: args.target_size_kb * 1024 }
            : {}),
          filename: path.basename(args.path),
        });
        const data = result.data;

        if (data.optimized === false && args.output_path === undefined) {
          // Honest no-op: the API returned the original bytes, so writing a
          // .min copy would just duplicate the file.
          return textResult(
            `${path.basename(args.path)} is already as small as Tinify.dev can make it ` +
              `(${formatBytes(data.original_bytes)}). The API returned the original bytes ` +
              `(optimized: false), so no file was written.`,
            imageStructuredContent({
              data,
              requestId: result.requestId,
              outputPath: null,
              wrote: false,
            }),
          );
        }

        const blob = await client.download(result);
        await writeResult(outputPath, blob);
        const pct = changePercent(data.original_bytes, data.result_bytes);
        const text =
          data.optimized === false
            ? `Tinify.dev could not make ${path.basename(args.path)} smaller ` +
              `(optimized: false). Wrote the unchanged ${formatBytes(data.result_bytes)} ` +
              `to ${outputPath} because output_path was explicitly requested.`
            : `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
              `(${pct}%), wrote ${outputPath}`;
        return textResult(
          text,
          imageStructuredContent({
            data,
            requestId: result.requestId,
            outputPath,
            wrote: true,
          }),
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};
