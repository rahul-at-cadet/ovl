/**
 * Upper bounds on how long the browser will wait for this app's API.
 *
 * `fetch` has no timeout of its own. A server that accepts the connection and
 * then never answers — mid-restart, saturated, or behind a proxy that dropped
 * the upstream — leaves the promise pending forever, and every `await` behind
 * it with it. That is not a hypothetical: it is what put the office app on
 * "Checking session..." with no way out but a manual reload, because
 * SuperTokens' session refresh is one such fetch and the whole screen waits on
 * it. See AppShell.
 *
 * A rejected request is recoverable — the caller shows an error, or falls back
 * to the login page. A request that never settles is not recoverable by any
 * caller, however careful, so the bound belongs at the transport rather than in
 * each screen.
 */

/**
 * How long any single request to our API may take before it is abandoned.
 *
 * Generous on purpose. This is not a latency budget — a slow office link on a
 * cold Next.js route can legitimately take seconds, and aborting real work
 * would be a worse bug than the one this fixes. It exists only to put a
 * ceiling on "never".
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long a screen may sit on a blocking session check before giving up.
 *
 * Deliberately longer than REQUEST_TIMEOUT_MS, so in the ordinary case the
 * request-level timeout fires first and the caller gets a real rejection to
 * act on. This is the backstop for the rest: SuperTokens' refresh path retries
 * internally around a cross-tab lock, in a loop with no exit of its own, so a
 * caller can be left waiting even when no single request is outstanding.
 */
export const SESSION_CHECK_TIMEOUT_MS = 25_000;

/** Thrown when {@link withDeadline} gives up. Distinguishable from a real error. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * An abort signal that fires when `ms` elapses, or when `signal` aborts.
 *
 * Both halves matter. The timeout is the point; forwarding the caller's own
 * signal is what keeps React Query able to cancel an in-flight query when a
 * component unmounts, which passing a bare timeout signal would silently
 * break.
 *
 * Written with AbortController rather than `AbortSignal.any` so it does not
 * depend on a browser API newer than the rest of this app requires.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(new TimeoutError(`Request exceeded ${ms}ms`)),
    ms,
  );
  // Clearing on abort covers both reasons this can end, including the timeout
  // itself, so a completed request never leaves a timer behind.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  return controller.signal;
}

/**
 * Resolves with `promise`, or rejects with a {@link TimeoutError} after `ms`.
 *
 * For waits that are not a single request and so cannot be bounded by an abort
 * signal. It does not cancel the underlying work — nothing here can — it only
 * stops the caller waiting on it indefinitely.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${what} did not finish within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
