// FILE: src/lib/retry.ts
// Generic retry-with-exponential-backoff wrapper for external API calls
// (OpenAI, Sarvam, Pinecone). Factored out of pinecone.ts's original
// upsertWithRateLimit loop so every external call gets the same treatment
// instead of re-implementing it per-file.
//
// This handles *transient* failures (429s, 5xxs, dropped connections) that
// usually clear within seconds. It's not a substitute for proactive rate
// limiting (see ratelimit.ts) and it's not trigger.dev's task-level retry
// in trigger.config.ts — that retry is for genuine job failures, and
// retrying a whole task burns upstream work (scrape/chunk/embed) just to
// redo one API call.

export interface RetryOptions {
    /** Total attempts including the first — default 5. */
    maxAttempts?: number;
    /** Decide whether an error is worth retrying at all. Default: never. */
    isRetryable?: (err: unknown) => boolean;
    /** Pull an explicit wait time (ms) from the error, e.g. Retry-After. */
    getRetryAfterMs?: (err: unknown) => number | undefined;
    /** Base delay for exponential backoff when no Retry-After is present. */
    baseDelayMs?: number;
    /** Ceiling for the backoff delay. */
    maxDelayMs?: number;
    /** Called before each sleep — hook for logging/metrics. */
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULTS = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 15_000,
} as const;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
): Promise<T> {
    const {
        maxAttempts = DEFAULTS.maxAttempts,
        isRetryable = () => false,
        getRetryAfterMs = () => undefined,
        baseDelayMs = DEFAULTS.baseDelayMs,
        maxDelayMs = DEFAULTS.maxDelayMs,
        onRetry,
    } = opts;

    let attempt = 0;

    for (; ;) {
        try {
            return await fn();
        } catch (err) {
            const isLastAttempt = attempt >= maxAttempts - 1;
            if (isLastAttempt || !isRetryable(err)) throw err;

            const explicitMs = getRetryAfterMs(err);
            const backoffMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
            const delayMs = explicitMs ?? backoffMs + Math.random() * 250;

            attempt++;
            onRetry?.(err, attempt, delayMs);
            await sleep(delayMs);
        }
    }
}

// Shared predicates
/** Pull an HTTP status off an OpenAI SDK error, a wrapped fetch error, or an axios-style error. */
export function getErrorStatus(err: unknown): number | undefined {
    const e = err as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
    };
    return e?.status ?? e?.statusCode ?? e?.response?.status;
}

const RETRYABLE_NETWORK_CODES = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
]);

const RETRYABLE_ERROR_NAMES = new Set([
    "APIConnectionError",
    "APIConnectionTimeoutError",
]);

/**
 * True for 429s, 5xxs, and connection-level failures (DNS/reset/timeout) —
 * the class of errors that's usually gone if you wait and try again.
 * False for 4xxs like 400/401/403/404/422, which fail identically on
 * retry and just burn the attempt budget.
 */
export function isRetryableError(err: unknown): boolean {
    const status = getErrorStatus(err);
    if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);

    const e = err as { code?: string; cause?: { code?: string }; name?: string };
    const code = e?.code ?? e?.cause?.code;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (e?.name && RETRYABLE_ERROR_NAMES.has(e.name)) return true;

    return false;
}

/** Extract a Retry-After header (seconds) from an OpenAI SDK error or a thrown fetch-response error, in ms. */
export function getRetryAfterMs(err: unknown): number | undefined {
    const e = err as {
        headers?: Record<string, string> | Headers;
        response?: { headers?: Record<string, string> | Headers };
    };
    const headers = e?.headers ?? e?.response?.headers;
    if (!headers) return undefined;

    const raw =
        typeof (headers as Headers).get === "function"
            ? (headers as Headers).get("retry-after")
            : (headers as Record<string, string>)["retry-after"];

    if (!raw) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}