import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  changePercent,
  formatBytes,
  imageStructuredContent,
  resolveOutputPath,
  textResult,
  toErrorResult,
  ToolInputError,
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

export interface ResizeImageArgs {
  path: string;
  output_path?: string;
  width?: number;
  height?: number;
  scale?: number;
  keep_aspect_ratio?: boolean;
  overwrite?: boolean;
}

export const resizeImageTool = {
  name: "resize_image",
  config: {
    title: "Resize image",
    description:
      "Resize a PNG, JPEG, WebP, or AVIF image with Tinify.dev by width, height, or scale, and write the result next to the original (or to output_path). At least one of width, height, or scale is required. The source image is never overwritten silently.",
    inputSchema: {
      path: pathSchema,
      output_path: outputPathSchema.optional(),
      width: z.number().int().positive().optional().describe("Target width in pixels."),
      height: z.number().int().positive().optional().describe("Target height in pixels."),
      scale: z
        .number()
        .positive()
        .optional()
        .describe("Scale factor, e.g. 0.5 halves both dimensions."),
      keep_aspect_ratio: z.boolean().optional(),
      overwrite: overwriteSchema.optional(),
    },
    outputSchema: imageOutputShape,
    annotations: {
      title: "Resize image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: ResizeImageArgs): Promise<TextResult> => {
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
        await validateInputPath(args.path);
        const outputPath = resolveOutputPath({
          inputPath: args.path,
          outputPath: args.output_path,
          overwrite: args.overwrite ?? false,
        });
        const bytes = new Uint8Array(await readFile(args.path));
        const result = await client.resize(bytes, {
          ...(args.width !== undefined ? { width: args.width } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
          ...(args.keep_aspect_ratio !== undefined
            ? { keep_aspect_ratio: args.keep_aspect_ratio }
            : {}),
          filename: path.basename(args.path),
        });
        const data = result.data;
        const blob = await client.download(result);
        await writeResult(outputPath, blob);
        const dims =
          data.width !== null && data.height !== null
            ? ` (${data.width}x${data.height})`
            : "";
        return textResult(
          `Resized ${path.basename(args.path)}${dims}: ` +
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
