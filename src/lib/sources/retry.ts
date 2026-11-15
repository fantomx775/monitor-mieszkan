type RetryOptions<T> = {
  signal?: AbortSignal;
  maxAttempts?: number;
  initialDelayMs?: number;
  shouldRetryValue?: (value: T) => boolean;
  shouldRetryError?: (error: unknown) => boolean;
  disposeValue?: (value: T) => Promise<void> | void;
};

function abortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry only caller-classified transient failures, with a bounded exponential delay. */
export async function retryTransient<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<{ value: T; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 2;
  const initialDelayMs = options.initialDelayMs ?? 400;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("Retry attempts must be an integer between 1 and 3.");
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 5_000) {
    throw new Error("Retry delay must be between 0 and 5000 milliseconds.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      const value = await operation(attempt);
      if (attempt < maxAttempts && options.shouldRetryValue?.(value)) {
        try {
          await options.disposeValue?.(value);
        } catch {
          // A response may already have closed; keep the retry decision unchanged.
        }
        await wait(initialDelayMs * 2 ** (attempt - 1), options.signal);
        continue;
      }
      return { value, attempts: attempt };
    } catch (error: unknown) {
      if (attempt >= maxAttempts || options.signal?.aborted || !options.shouldRetryError?.(error)) {
        throw error;
      }
      await wait(initialDelayMs * 2 ** (attempt - 1), options.signal);
    }
  }

  throw new Error("Retry loop ended without a result.");
}
