import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  changePercent,
  DOWNLOAD_TIMEOUT_MS,
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

export interface CropImageArgs {
  path: string;
  output_path?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  overwrite?: boolean;
}

export const cropImageTool = {
  name: "crop_image",
  config: {
    title: "Crop image",
    description:
      "Crop a PNG, JPEG, WebP, or AVIF image with Tinify.dev to the given rectangle and write the result next to the original (or to output_path). The source image is never overwritten silently.",
    inputSchema: {
      path: pathSchema,
      output_path: outputPathSchema.optional(),
      x: z.number().int().nonnegative().describe("Left edge of the crop rectangle in pixels."),
      y: z.number().int().nonnegative().describe("Top edge of the crop rectangle in pixels."),
      width: z.number().int().positive().describe("Crop width in pixels."),
      height: z.number().int().positive().describe("Crop height in pixels."),
      overwrite: overwriteSchema.optional(),
    },
    outputSchema: imageOutputShape,
    annotations: {
      title: "Crop image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (args: CropImageArgs): Promise<TextResult> => {
      try {
        await validateInputPath(args.path);
        const outputPath = resolveOutputPath({
          inputPath: args.path,
          outputPath: args.output_path,
          overwrite: args.overwrite ?? false,
        });
        const bytes = new Uint8Array(await readFile(args.path));
        const result = await client.crop(bytes, {
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          filename: path.basename(args.path),
        });
        const data = result.data;
        const blob = await client.download(result, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        await writeResult(outputPath, blob);
        return textResult(
          `Cropped ${path.basename(args.path)} to ${args.width}x${args.height}` +
            `+${args.x}+${args.y}: ${formatBytes(data.original_bytes)} → ` +
            `${formatBytes(data.result_bytes)} ` +
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
