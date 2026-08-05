import { describe, expect, it, vi } from "vitest";
import {
  downloadOpenAIFile,
  isPublicIpAddress,
} from "../src/tools/remote-input.js";

const SMALL_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("ChatGPT attachment downloader", () => {
  it("accepts a bounded HTTPS image from a public host", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
      return new Response(SMALL_PNG.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(SMALL_PNG.byteLength),
        },
      });
      },
    );
    const bytes = await downloadOpenAIFile(
      {
        download_url: "https://files.openai.example/photo.png",
        file_id: "file_photo",
        mime_type: "image/png",
        file_name: "photo.png",
      },
      {
        fetch: fetchImpl,
        resolveHostname: async () => ["93.184.216.34"],
      },
    );
    expect(bytes).toEqual(SMALL_PNG);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("rejects non-HTTPS and private-network targets before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      downloadOpenAIFile(
        {
          download_url: "http://files.example/photo.png",
          file_id: "file_photo",
        },
        {
          fetch: fetchImpl,
          resolveHostname: async () => ["93.184.216.34"],
        },
      ),
    ).rejects.toThrow("must use HTTPS");
    await expect(
      downloadOpenAIFile(
        {
          download_url: "https://internal.example/photo.png",
          file_id: "file_photo",
        },
        {
          fetch: fetchImpl,
          resolveHostname: async () => ["10.0.0.5"],
        },
      ),
    ).rejects.toThrow("private or reserved");
    await expect(
      downloadOpenAIFile(
        {
          download_url: "https://[::1]/photo.png",
          file_id: "file_photo",
        },
        { fetch: fetchImpl },
      ),
    ).rejects.toThrow("private or reserved");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported MIME types and oversized declared bodies", async () => {
    const publicResolver = async () => ["93.184.216.34"];
    await expect(
      downloadOpenAIFile(
        {
          download_url: "https://files.example/document.pdf",
          file_id: "file_pdf",
          mime_type: "application/pdf",
        },
        { resolveHostname: publicResolver },
      ),
    ).rejects.toThrow("Unsupported attached file type");

    const fetchImpl = vi.fn(async () => {
      return new Response(SMALL_PNG.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(40 * 1024 * 1024 + 1),
        },
      });
    });
    await expect(
      downloadOpenAIFile(
        {
          download_url: "https://files.example/large.png",
          file_id: "file_large",
          mime_type: "image/png",
        },
        { fetch: fetchImpl, resolveHostname: publicResolver },
      ),
    ).rejects.toThrow("exceeds the 40 MB");
  });
});

describe("public IP classification", () => {
  it("blocks private, loopback, link-local, and documentation ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "203.0.113.7",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });
});
