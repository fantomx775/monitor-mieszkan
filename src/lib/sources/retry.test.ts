import { describe, expect, it, vi } from "vitest";

import { retryTransient } from "./retry";

describe("retryTransient", () => {
  it("retries a transient response once and disposes of its body", async () => {
    const operation = vi.fn<() => Promise<{ status: number }>>()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });
    const disposeValue = vi.fn();

    const result = await retryTransient(operation, {
      initialDelayMs: 0,
      shouldRetryValue: (value) => value.status >= 500,
      disposeValue,
    });

    expect(result).toEqual({ value: { status: 200 }, attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(disposeValue).toHaveBeenCalledTimes(1);
  });

  it("retries a transient network error but stops after the configured attempts", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"));

    await expect(retryTransient(operation, {
      initialDelayMs: 0,
      shouldRetryError: (error) => error instanceof TypeError,
    })).rejects.toThrow("network");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry policy responses or a cancelled operation", async () => {
    const operation = vi.fn<() => Promise<{ status: number }>>().mockResolvedValue({ status: 429 });
    const response = await retryTransient(operation, {
      initialDelayMs: 0,
      shouldRetryValue: (value) => value.status >= 500,
    });
    expect(response.attempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = vi.fn();
    await expect(retryTransient(cancelled, { signal: controller.signal, initialDelayMs: 0 }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).not.toHaveBeenCalled();
  });
});
