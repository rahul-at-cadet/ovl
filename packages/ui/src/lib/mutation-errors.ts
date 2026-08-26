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

function errorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code && BY_CODE[code]) return BY_CODE[code];

  const message = (error as { message?: string } | null)?.message;
  if (message && message.trim()) return message;

  // A fetch that never reached the server has no tRPC shape at all.
  return 'Could not reach the server. Check your connection and try again.';
}

export function mutationErrorToast(error: unknown, meta?: MutationMeta): ToastInput {
  return {
    title: meta?.errorTitle ?? "That didn't save",
    description: errorMessage(error),
    type: 'error',
  };
}
