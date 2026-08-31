/**
 * Turns a failed mutation into something a person can act on.
 *
 * A raw tRPC error message is written for whoever is reading the server log,
 * not for the officer who just clicked Save — "UNAUTHORIZED" tells them
 * nothing about what to do next. The codes below are the ones the user can
 * actually respond to; anything else falls through to the server's own
 * message, which for this API is generally written for a human already.
 */

export interface MutationMeta {
  /** The mutation renders its own error inline; skip the global toast. */
  silentError?: boolean;
  /** Headline for the toast, e.g. "Couldn't save the field policy". */
  errorTitle?: string;
}

interface ToastInput {
  title: string;
  description: string;
  type: 'error';
}

const BY_CODE: Record<string, string> = {
  UNAUTHORIZED: 'Your session has expired. Sign in again to continue.',
  FORBIDDEN: "Your account doesn't have permission to do that.",
  NOT_FOUND: 'That record no longer exists — it may have been deleted already.',
  CONFLICT: 'Someone else changed this first. Reload and try again.',
  TIMEOUT: 'The server took too long to respond. Try again in a moment.',
  TOO_MANY_REQUESTS: 'Too many requests. Wait a moment and try again.',
  INTERNAL_SERVER_ERROR: 'The server hit an unexpected error. Try again in a moment.',
};

function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: { code?: string } } | null)?.data;
  return data?.code;
}

/**
 * Diagnostics thrown by the SuperTokens client rather than by this API.
 *
 * The fall-through below trusts a message because this API writes its errors
 * for people. The auth SDK does not: when its refresh loop gives up it throws
 * a paragraph naming the endpoint it called, how many times it retried and
 * which config key to raise — useful in a bug report, meaningless to whoever
 * is trying to sign in, and it lands on screen verbatim wherever a catch
 * block renders `err.message`. Matched on the config key it recommends, which
 * is the one part of that text that cannot appear in an ordinary message.
 */
const SDK_SESSION_DIAGNOSTIC = /maxRetryAttemptsForSessionRefresh/i;

/**
 * The browser's own wording for a request that never reached a server.
 *
 * Chrome says "Failed to fetch", Safari "Load failed", Firefox
 * "NetworkError when attempting to fetch resource" — none of which name the
 * one thing worth checking. Mapped here rather than at each call site so the
 * toast and the sign-in screen say the same thing.
 */
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|network request failed/i;

/**
 * A message worth showing a person, from any thrown value.
 *
 * Exported because the same problem exists outside mutations — the sign-in
 * screen catches raw SDK errors, and it should say what the toast would say.
 */
export function humanErrorMessage(error: unknown, fallback?: string): string {
  const code = errorCode(error);
  if (code && BY_CODE[code]) return BY_CODE[code];

  const message = (error as { message?: string } | null)?.message;
  if (message && SDK_SESSION_DIAGNOSTIC.test(message)) {
    return 'Your session is no longer valid. Sign in again to continue.';
  }
  // A fetch that never reached the server has no tRPC shape at all, so this
  // is checked before the message is trusted rather than as a fallback.
  if (message && NETWORK_FAILURE.test(message)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (message && message.trim()) return message;

  return fallback ?? 'Could not reach the server. Check your connection and try again.';
}

export function mutationErrorToast(error: unknown, meta?: MutationMeta): ToastInput {
  return {
    title: meta?.errorTitle ?? "That didn't save",
    description: humanErrorMessage(error),
    type: 'error',
  };
}
