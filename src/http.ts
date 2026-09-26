export interface FetchPolicy {
  deadlineMs: number;
  maxBodyBytes: number;
  /** Mutations must disable retries, even when an upstream suggests a retry. */
  safe: boolean;
  retries?: number;
  retryOn?: (status: number) => boolean;
  honorRetryAfter?: boolean;
}

export interface BoundedResponse {
  status: number;
  headers: Headers;
  bodyText: string;
  truncated: boolean;
  retryAfterMs?: number;
  attempts: number;
}

export class DeadlineExceeded extends Error {
  constructor(message = "Fetch deadline exceeded") {
    super(message);
    this.name = "DeadlineExceeded";
  }
}

/** Remove userinfo, query and fragment, including from signed URLs. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[redacted URL]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

/** Validation is synchronous so unsafe retry configuration fails before dispatch. */
export function fetchBounded(
  input: RequestInfo,
  init: RequestInit,
  policy: FetchPolicy,
): Promise<BoundedResponse> {
  const retries = policy.retries ?? 0;
  if (typeof policy.safe !== "boolean") throw new TypeError("Fetch policy requires safe");
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError("Invalid retry count");
  if (!policy.safe && retries > 0) throw new TypeError("Unsafe requests cannot use retries");
  if (!Number.isFinite(policy.deadlineMs) || policy.deadlineMs <= 0 || policy.deadlineMs > 2147483647) {
    throw new RangeError("Invalid fetch deadline");
  }
  if (!Number.isSafeInteger(policy.maxBodyBytes) || policy.maxBodyBytes < 0) {
    throw new RangeError("Invalid body byte limit");
  }
  if (retries > 0 && init.body instanceof ReadableStream) {
    throw new TypeError("A streaming request body cannot be retried");
  }
  return execute(input, init, { ...policy, retries });
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation may itself stall on a broken upstream. It must not extend the deadline.
  if (body) void body.cancel().catch(() => {});
}

async function execute(
  input: RequestInfo,
  init: RequestInit,
  policy: FetchPolicy & { retries: number },
): Promise<BoundedResponse> {
  const url = redactUrl(typeof input === "string" ? input : input.url);
  const controller = new AbortController();
  const deadline = performance.now() + policy.deadlineMs;
  const inheritedSignal = init.signal ?? (typeof input === "string" ? undefined : input.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.deadlineMs);
  const abort = () => controller.abort();
  inheritedSignal?.addEventListener("abort", abort, { once: true });
  if (inheritedSignal?.aborted) controller.abort();
  const interruption = () => timedOut
    ? new DeadlineExceeded(`Fetch deadline exceeded for ${url}`)
    : new Error(`Fetch aborted for ${url}`);
  const checkDeadline = () => {
    // Ready stream chunks can keep the microtask queue busy and delay the timer callback.
    if (performance.now() >= deadline) {
      timedOut = true;
      controller.abort();
    }
  };

  // Race even noncooperative fetch/stream implementations against the one deadline.
  const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    checkDeadline();
    const onAbort = () => reject(interruption());
    if (controller.signal.aborted) {
      void work.catch(() => {});
      reject(interruption());
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      controller.signal.removeEventListener("abort", onAbort);
    });
  });
  const pause = (milliseconds: number) => {
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    const work = new Promise<void>((resolve) => {
      sleepTimer = setTimeout(resolve, Math.min(milliseconds, 2147483647));
    });
    return bounded(work).finally(() => clearTimeout(sleepTimer));
  };

  try {
    for (let attempt = 1; ; attempt++) {
      checkDeadline();
      if (controller.signal.aborted) throw interruption();
      let response: Response;
      try {
        // Clone Request inputs so an explicitly safe request remains replayable.
        const request = typeof input === "string" ? input : input.clone();
        const pending = fetch(request, { ...init, signal: controller.signal });
        void pending.then((late) => {
          if (controller.signal.aborted) cancelBody(late.body);
        }, () => {});
        response = await bounded(pending);
      } catch {
        if (controller.signal.aborted) throw interruption();
        if (!policy.safe || attempt > policy.retries) throw new Error(`Fetch failed for ${url}`);
        await pause(Math.min(100 * 2 ** (attempt - 1), 5000));
        continue;
      }
      const wait = policy.safe ? retryAfter(response.headers.get("retry-after")) : undefined;
      let shouldRetry = false;
      try {
        shouldRetry = policy.safe && attempt <= policy.retries && (
          policy.retryOn?.(response.status) ?? (response.status === 429 || response.status >= 500)
        );
      } catch {
        cancelBody(response.body);
        throw new Error(`Fetch retry policy failed for ${url}`);
      }
      if (shouldRetry) {
        cancelBody(response.body);
        await pause(policy.honorRetryAfter !== false && wait !== undefined
          ? wait : Math.min(100 * 2 ** (attempt - 1), 5000));
        continue;
      }
      const reader = response.body?.getReader();
      // Malformed UTF8 must not expand to replacement characters beyond the byte cap.
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bodyText = "";
      let bytes = 0;
      let truncated = false;
      if (reader) {
        try {
          while (true) {
            const chunk = await bounded(reader.read());
            if (chunk.done) {
              bodyText += decoder.decode();
              break;
            }
            const remaining = policy.maxBodyBytes - bytes;
            const accepted = chunk.value.subarray(0, remaining);
            bytes += accepted.byteLength;
            bodyText += decoder.decode(accepted, { stream: true });
            if (chunk.value.byteLength > remaining) {
              truncated = true;
              // Do not flush a split code point into a replacement character that exceeds the cap.
              void reader.cancel().catch(() => {});
              break;
            }
          }
        } catch {
          void reader.cancel().catch(() => {});
          if (controller.signal.aborted) throw interruption();
          throw new Error(`Fetch body read failed for ${url}`);
        } finally {
          reader.releaseLock();
        }
      }
      const result: BoundedResponse = {
        status: response.status, headers: response.headers, bodyText, truncated, attempts: attempt,
      };
      checkDeadline();
      if (controller.signal.aborted) throw interruption();
      if (wait !== undefined) result.retryAfterMs = wait;
      return result;
    }
  } catch (error) {
    // Neither upstream exception messages nor their causes are safe to expose.
    if (controller.signal.aborted) throw interruption();
    if (error instanceof DeadlineExceeded) throw new DeadlineExceeded(`Fetch deadline exceeded for ${url}`);
    throw new Error(`Fetch failed for ${url}`);
  } finally {
    clearTimeout(timer);
    inheritedSignal?.removeEventListener("abort", abort);
  }
}
