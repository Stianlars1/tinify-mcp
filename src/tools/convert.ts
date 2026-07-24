import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { QualityMode, TargetFormat } from "@tinify-dev/client";
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
import {
  imageOutputShape,
  outputPathSchema,
  overwriteSchema,
  pathSchema,
} from "./compress.js";

export const FORMAT_EXTENSIONS: Record<TargetFormat, string> = {
  avif: ".avif",
  webp: ".webp",
  jpeg: ".jpg",
  png: ".png",
};

export interface ConvertImageArgs {
  path: string;
  format: TargetFormat;
  output_path?: string;
  quality_mode?: QualityMode;
  overwrite?: boolean;
}

export const convertImageTool = {
  name: "convert_image",
  config: {
    title: "Convert image format",
    description:
      "Convert an image to AVIF, WebP, JPEG, or PNG with Tinify.dev (beta endpoint; may not be enabled on every account yet). Writes <name>.min.<new-ext> next to the original unless output_path is given. Converting to the same format is rejected by the API (same_format_conversion).",
    inputSchema: {
      path: pathSchema,
      format: z
        .enum(["avif", "webp", "jpeg", "png"])
        .describe("Target format."),
      output_path: outputPathSchema.optional(),
      quality_mode: z
        .enum(["balanced", "best_quality", "lossless"])
        .optional(),
      overwrite: overwriteSchema.optional(),
    },
    outputSchema: imageOutputShape,
    annotations: {
      title: "Convert image format",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: ConvertImageArgs): Promise<TextResult> => {
      try {
        await validateInputPath(args.path);
        const outputPath = resolveOutputPath({
          inputPath: args.path,
          outputPath: args.output_path,
          overwrite: args.overwrite ?? false,
          targetExt: FORMAT_EXTENSIONS[args.format],
        });
        const bytes = new Uint8Array(await readFile(args.path));
        const result = await client.convert(bytes, {
          format: args.format,
          ...(args.quality_mode !== undefined
            ? { quality_mode: args.quality_mode }
            : {}),
          filename: path.basename(args.path),
        });
        const data = result.data;
        const blob = await client.download(result);
        await writeResult(outputPath, blob);
        return textResult(
          `Converted ${path.basename(args.path)} to ${args.format}: ` +
            `${formatBytes(data.original_bytes)} → ${formatBytes(data.result_bytes)} ` +
            `(${changePercent(data.original_bytes, data.result_bytes)}%), wrote ${outputPath}`,
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
