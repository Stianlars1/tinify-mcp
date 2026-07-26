import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TinifyApiError,
  type ImageResultData,
  type TinifyResponse,
  type Usage,
} from "@tinify-dev/client";
import { compressImageTool } from "../src/tools/compress.js";
import { convertImageTool } from "../src/tools/convert.js";
import { cropImageTool } from "../src/tools/crop.js";
import { resizeImageTool } from "../src/tools/resize.js";
import { getUsageTool } from "../src/tools/usage.js";
import type { TinifyLikeClient } from "../src/tools/shared.js";
import { allTools } from "../src/server.js";
import {
  ConfigError,
  MissingApiKeyError,
  loadConfig,
  readConfig,
} from "../src/config.js";
import { createUnconfiguredClient } from "../src/unconfigured-client.js";

const RESULT_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function imageResult(
  overrides: Partial<ImageResultData> = {},
): TinifyResponse<ImageResultData> {
  return {
    data: {
      job_id: "job_1",
      status: "succeeded",
      optimized: true,
      original_bytes: 319_897,
      result_bytes: 99_430,
      width: 1200,
      height: 800,
      download_url: "https://api.tinify.dev/dl/abc",
      expires_at: "2026-07-24T12:00:00Z",
      ...overrides,
    },
    requestId: "req_test_1",
    rateLimit: null,
  };
}

function fakeClient(overrides: Partial<TinifyLikeClient> = {}): TinifyLikeClient {
  return {
    compress: vi.fn(async () => imageResult()),
    resize: vi.fn(async () => imageResult({ optimized: null })),
    crop: vi.fn(async () => imageResult({ optimized: null })),
    convert: vi.fn(async () => imageResult({ result_format: "webp" })),
    usage: vi.fn(
      async (): Promise<TinifyResponse<Usage>> => ({
        data: {
          plan: "developer",
          period_start: "2026-07-01",
          period_end: "2026-07-31",
          included: 500,
          reserved: 0,
          used: 132,
          remaining: 368,
        },
        requestId: "req_usage_1",
        rateLimit: null,
      }),
    ),
    download: vi.fn(async () => new Blob([RESULT_BYTES])),
    ...overrides,
  };
}

let dir: string;
let input: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tinify-mcp-test-"));
  input = path.join(dir, "photo.png");
  await writeFile(input, new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("compress_image", () => {
  it("compresses and writes <name>.min.<ext> beside the input", async () => {
    const client = fakeClient();
    const result = await compressImageTool.makeHandler(client)({ path: input });

    expect(result.isError).toBeUndefined();
    const expectedOut = path.join(dir, "photo.min.png");
    expect(result.content[0]?.text).toContain("312.4 KB → 97.1 KB");
    expect(result.content[0]?.text).toContain(`wrote ${expectedOut}`);
    expect(result.structuredContent).toMatchObject({
      original_bytes: 319_897,
      result_bytes: 99_430,
      saved_bytes: 220_467,
      change_percent: -68.9,
      optimized: true,
      output_path: expectedOut,
      wrote: true,
      request_id: "req_test_1",
    });
    const written = await readFile(expectedOut);
    expect(new Uint8Array(written)).toEqual(RESULT_BYTES);
    // Source untouched.
    expect((await stat(input)).size).toBe(8);
  });

  it("passes quality_mode and converts target_size_kb to bytes", async () => {
    const client = fakeClient();
    await compressImageTool.makeHandler(client)({
      path: input,
      quality_mode: "best_quality",
      target_size_kb: 100,
    });
    expect(client.compress).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        quality_mode: "best_quality",
        target_size_bytes: 102_400,
        filename: "photo.png",
      }),
    );
  });

  it("is honest and writes nothing when optimized is false", async () => {
    const client = fakeClient({
      compress: vi.fn(async () =>
        imageResult({
          optimized: false,
          original_bytes: 5_000,
          result_bytes: 5_000,
        }),
      ),
    });
    const result = await compressImageTool.makeHandler(client)({ path: input });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("optimized: false");
    expect(result.content[0]?.text).toContain("no file was written");
    expect(result.structuredContent).toMatchObject({
      optimized: false,
      saved_bytes: 0,
      output_path: null,
      wrote: false,
    });
    expect(client.download).not.toHaveBeenCalled();
    await expect(stat(path.join(dir, "photo.min.png"))).rejects.toThrow();
  });

  it("still writes an optimized:false result when output_path is explicit", async () => {
    const out = path.join(dir, "copy.png");
    const client = fakeClient({
      compress: vi.fn(async () =>
        imageResult({ optimized: false, original_bytes: 5, result_bytes: 5 }),
      ),
    });
    const result = await compressImageTool.makeHandler(client)({
      path: input,
      output_path: out,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("could not make");
    expect(result.structuredContent).toMatchObject({ output_path: out, wrote: true });
    await expect(stat(out)).resolves.toBeTruthy();
  });

  it("rejects relative paths", async () => {
    const result = await compressImageTool.makeHandler(fakeClient())({
      path: "photo.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("must be absolute");
  });

  it("rejects missing files", async () => {
    const result = await compressImageTool.makeHandler(fakeClient())({
      path: path.join(dir, "nope.png"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("File not found");
  });

  it("rejects unsupported extensions", async () => {
    const gif = path.join(dir, "anim.gif");
    await writeFile(gif, new Uint8Array([71, 73, 70]));
    const result = await compressImageTool.makeHandler(fakeClient())({ path: gif });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unsupported file type ".gif"');
  });

  it("pre-guards files over 40 MB without calling the API", async () => {
    const big = path.join(dir, "big.png");
    const handle = await open(big, "w");
    await handle.truncate(41_943_041); // sparse file, 40 MiB + 1 byte
    await handle.close();
    const client = fakeClient();
    const result = await compressImageTool.makeHandler(client)({ path: big });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exceeds the 40 MB API limit");
    expect(client.compress).not.toHaveBeenCalled();
  });

  it("refuses to overwrite the source without overwrite: true", async () => {
    const result = await compressImageTool.makeHandler(fakeClient())({
      path: input,
      output_path: input,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Refusing to overwrite the source image");
  });

  it("overwrites the source only when explicitly asked", async () => {
    const result = await compressImageTool.makeHandler(fakeClient())({
      path: input,
      output_path: input,
      overwrite: true,
    });
    expect(result.isError).toBeUndefined();
    expect(new Uint8Array(await readFile(input))).toEqual(RESULT_BYTES);
  });

  it("refuses to replace an existing output file without overwrite: true", async () => {
    const out = path.join(dir, "photo.min.png");
    await writeFile(out, new Uint8Array([9]));
    const result = await compressImageTool.makeHandler(fakeClient())({ path: input });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already exists");
    expect((await readFile(out)).length).toBe(1);
  });

  it("maps TinifyApiError to an isError result with code and request_id", async () => {
    const client = fakeClient({
      compress: vi.fn(async () => {
        throw new TinifyApiError({
          status: 429,
          code: "quota_exhausted",
          message: "Monthly quota used up.",
          requestId: "req_err_9",
          retryAfter: 3600,
        });
      }),
    });
    const result = await compressImageTool.makeHandler(client)({ path: input });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("quota_exhausted");
    expect(result.content[0]?.text).toContain("HTTP 429");
    expect(result.content[0]?.text).toContain("req_err_9");
    expect(result.content[0]?.text).toContain("Retry after 3600s");
  });
});

describe("resize_image", () => {
  it("requires at least one of width, height, scale", async () => {
    const result = await resizeImageTool.makeHandler(fakeClient())({ path: input });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("at least one of width, height, or scale");
  });

  it("resizes and writes the result", async () => {
    const client = fakeClient();
    const result = await resizeImageTool.makeHandler(client)({
      path: input,
      width: 1200,
      keep_aspect_ratio: true,
    });
    expect(result.isError).toBeUndefined();
    expect(client.resize).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ width: 1200, keep_aspect_ratio: true }),
    );
    expect(result.content[0]?.text).toContain("Resized photo.png (1200x800)");
    expect(result.structuredContent).toMatchObject({ optimized: null, wrote: true });
    await expect(stat(path.join(dir, "photo.min.png"))).resolves.toBeTruthy();
  });
});

describe("crop_image", () => {
  it("crops and writes the result", async () => {
    const client = fakeClient();
    const result = await cropImageTool.makeHandler(client)({
      path: input,
      x: 10,
      y: 20,
      width: 600,
      height: 400,
    });
    expect(result.isError).toBeUndefined();
    expect(client.crop).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ x: 10, y: 20, width: 600, height: 400 }),
    );
    expect(result.content[0]?.text).toContain("Cropped photo.png to 600x400+10+20");
  });
});

describe("convert_image", () => {
  it("converts and derives the new extension for the default output", async () => {
    const client = fakeClient();
    const result = await convertImageTool.makeHandler(client)({
      path: input,
      format: "webp",
    });
    expect(result.isError).toBeUndefined();
    const expectedOut = path.join(dir, "photo.min.webp");
    expect(client.convert).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ format: "webp" }),
    );
    expect(result.content[0]?.text).toContain(`wrote ${expectedOut}`);
    expect(result.structuredContent).toMatchObject({ output_path: expectedOut });
    await expect(stat(expectedOut)).resolves.toBeTruthy();
  });

  it("maps jpeg to a .jpg default extension", async () => {
    const client = fakeClient();
    await convertImageTool.makeHandler(client)({ path: input, format: "jpeg" });
    await expect(stat(path.join(dir, "photo.min.jpg"))).resolves.toBeTruthy();
  });
});

describe("get_usage", () => {
  it("summarizes plan and remaining operations", async () => {
    const result = await getUsageTool.makeHandler(fakeClient())();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "Plan developer: 132 of 500 operations used (368 remaining) in the period 2026-07-01 → 2026-07-31.",
    );
    expect(result.structuredContent).toMatchObject({
      plan: "developer",
      included: 500,
      used: 132,
      remaining: 368,
      request_id: "req_usage_1",
    });
  });

  it("surfaces API errors with code and request_id", async () => {
    const client = fakeClient({
      usage: vi.fn(async () => {
        throw new TinifyApiError({
          status: 401,
          code: "invalid_api_key",
          message: "The API key is invalid or revoked.",
          requestId: "req_err_2",
        });
      }),
    });
    const result = await getUsageTool.makeHandler(client)();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid_api_key");
    expect(result.content[0]?.text).toContain("req_err_2");
  });
});

describe("server", () => {
  it("registers exactly the five planned tools", () => {
    expect(allTools.map((tool) => tool.name)).toEqual([
      "compress_image",
      "resize_image",
      "crop_image",
      "convert_image",
      "get_usage",
    ]);
  });
});

describe("config", () => {
  it("throws a readable ConfigError when TINIFY_API_KEY is unset", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TINIFY_API_KEY: "  " })).toThrow(
      /TINIFY_API_KEY is not set/,
    );
    try {
      loadConfig({});
    } catch (error) {
      expect((error as Error).message).toContain("claude mcp add tinify");
      expect((error as Error).message).toContain("tinify.dev/developers");
    }
  });

  it("reads the key and optional base URL", () => {
    expect(loadConfig({ TINIFY_API_KEY: "tnf_test_x" })).toEqual({
      apiKey: "tnf_test_x",
    });
    expect(
      loadConfig({ TINIFY_API_KEY: "tnf_test_x", TINIFY_BASE_URL: "http://localhost:8080" }),
    ).toEqual({ apiKey: "tnf_test_x", baseUrl: "http://localhost:8080" });
  });

  it("readConfig reports a missing key instead of throwing", () => {
    // The server has to survive this: exiting here is what left MCP clients
    // showing a failed connection and no reason for it.
    expect(readConfig({})).toEqual({});
    expect(readConfig({ TINIFY_API_KEY: "  " })).toEqual({});
    expect(readConfig({ TINIFY_API_KEY: "tnf_test_x" })).toEqual({
      apiKey: "tnf_test_x",
    });
    expect(
      readConfig({ TINIFY_API_KEY: "tnf_test_x", TINIFY_BASE_URL: "http://x" }),
    ).toEqual({ apiKey: "tnf_test_x", baseUrl: "http://x" });
  });
});

describe("unconfigured client", () => {
  it("refuses every operation with the setup instruction", async () => {
    const client = createUnconfiguredClient();
    const calls: Array<() => unknown> = [
      () => client.usage(),
      () => client.compress(new Uint8Array([1])),
      () => client.resize(new Uint8Array([1])),
      () => client.crop(new Uint8Array([1]), { x: 0, y: 0, width: 1, height: 1 }),
      () => client.convert(new Uint8Array([1]), { format: "webp" }),
    ];
    for (const call of calls) {
      expect(call).toThrow(MissingApiKeyError);
      expect(call).toThrow(/TINIFY_API_KEY is not set/);
    }
  });

  it("surfaces the instruction through a real tool call, not as a crash", async () => {
    const result = await getUsageTool.makeHandler(createUnconfiguredClient())();
    expect(result.isError).toBe(true);
    // Verbatim - not wrapped in "Unexpected error:".
    expect(result.content[0]?.text).toContain("TINIFY_API_KEY is not set");
    expect(result.content[0]?.text).toContain("tinify.dev/developers");
    expect(result.content[0]?.text).not.toContain("Unexpected error");
  });
});
