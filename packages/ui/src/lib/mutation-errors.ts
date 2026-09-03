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

/**
 * Codes where the server's own message beats the generic one above.
 *
 * A refusal is only actionable if it says *what* was missing. This API's
 * authorization errors already do — "Only a Config Manager may author
 * configuration." names the exact role to go and ask for — and the generic
 * line replaced that with "your account doesn't have permission", which
 * tells the reader only that they are stuck. Roles here are additive rather
 * than hierarchical, so being an admin and still being refused is a normal
 * situation and a confusing one to hit without the specifics.
 *
 * Deliberately not every code: INTERNAL_SERVER_ERROR and UNAUTHORIZED
 * messages come from places that leak driver text and stack detail, which
 * is what the generic table is for.
 */
const PREFER_SERVER_MESSAGE = new Set(['FORBIDDEN']);

function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: { code?: string } } | null)?.data;
  return data?.code;
}

function serverMessage(error: unknown, code: string | undefined): string | undefined {
  const message = (error as { message?: string } | null)?.message?.trim();
  if (!message) return undefined;
  // tRPC defaults an error's message to its own code name when the thrower
  // gave none, and "FORBIDDEN" is not a sentence worth showing anyone.
  if (message === code) return undefined;
  return message;
}

function errorMessage(error: unknown): string {
  const code = errorCode(error);

  if (code && PREFER_SERVER_MESSAGE.has(code)) {
    const specific = serverMessage(error, code);
    if (specific) return specific;
  }

  if (code && BY_CODE[code]) return BY_CODE[code];

  const message = serverMessage(error, code);
  if (message) return message;

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
