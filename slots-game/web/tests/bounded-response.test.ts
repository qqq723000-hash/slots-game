import { describe, expect, it, vi } from "vitest";
import {
  NetworkResponseLimitError,
  readBoundedResponseBytes,
  readBoundedResponseText,
} from "../src/network/boundedResponse";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const runtimeSources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

function streamedResponse(
  chunks: readonly Uint8Array[],
  headers?: HeadersInit,
  onCancel?: (reason: unknown) => void,
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  }), { status: 200, headers });
}

describe("bounded network response readers", () => {
  it("keeps every explicit runtime Response body read behind the bounded reader", () => {
    for (const [file, source] of Object.entries(runtimeSources)) {
      expect(source, file).not.toMatch(/\bresponse\.(?:arrayBuffer|blob|formData|json|text)\s*\(/);
    }
  });

  it("rejects an oversized declared length before consuming a body and cancels it", async () => {
    const cancelled = vi.fn();
    const response = streamedResponse(
      [bytes("body-must-not-be-read")],
      { "content-length": "9" },
      cancelled,
    );

    await expect(readBoundedResponseBytes(response, {
      label: "test response",
      maxBytes: 8,
    })).rejects.toBeInstanceOf(NetworkResponseLimitError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not trust a forged smaller Content-Length and cancels on the first excess chunk", async () => {
    const cancelled = vi.fn();
    const response = streamedResponse(
      [bytes("1234"), bytes("5"), bytes("must-not-be-pulled")],
      { "content-length": "1" },
      cancelled,
    );

    await expect(readBoundedResponseBytes(response, {
      label: "forged response",
      maxBytes: 4,
    })).rejects.toMatchObject({
      name: "NetworkResponseLimitError",
      limitBytes: 4,
      receivedBytes: 5,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds a chunked response without Content-Length by accumulated bytes", async () => {
    const cancelled = vi.fn();
    const response = streamedResponse(
      [bytes("12"), bytes("34"), bytes("56")],
      undefined,
      cancelled,
    );

    await expect(readBoundedResponseText(response, {
      label: "chunked response",
      maxBytes: 5,
    })).rejects.toBeInstanceOf(NetworkResponseLimitError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("returns exact bytes when a chunked body stays within the limit", async () => {
    const response = streamedResponse([bytes("商"), bytes("用")]);

    await expect(readBoundedResponseText(response, {
      label: "utf8 response",
      maxBytes: 6,
    })).resolves.toBe("商用");
  });

  it("fails closed when a non-empty response cannot expose a streaming body", async () => {
    const response = {
      headers: new Headers({ "content-length": "1" }),
      status: 200,
      body: null,
      arrayBuffer: vi.fn(async () => bytes("unbounded").buffer),
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, {
      label: "opaque response",
      maxBytes: 8,
    })).rejects.toThrow(/streaming body/i);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });
});
