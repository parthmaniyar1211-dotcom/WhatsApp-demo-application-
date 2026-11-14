// Meta Graph API helper with retry and exponential backoff.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  attempts?: number; // total tries, default 3
  baseDelayMs?: number; // default 500 ms, doubled every retry
  timeoutMs?: number; // per try, default 15 s
}

/**
 * fetch() that retries on network errors, HTTP 429 and HTTP 5xx.
 * Other responses (including 4xx) are returned to the caller as-is.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let lastError: unknown = new Error("no attempt made");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) return response;
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function graphUrl(version: string, path: string): string {
  return `https://graph.facebook.com/${version}/${path}`;
}

/** Turn a Graph API error response into a short reason that is safe to store and show. */
export async function graphErrorReason(response: Response): Promise<string> {
  let reason = `WhatsApp API error (HTTP ${response.status})`;
  try {
    const data = await response.json();
    const err = data?.error;
    if (err) {
      const detail = err.error_data?.details ?? err.message ?? "";
      reason = `${err.code ?? response.status}: ${detail}`.slice(0, 300);
    }
  } catch {
    // Not JSON: keep the generic reason.
  }
  return reason;
}
