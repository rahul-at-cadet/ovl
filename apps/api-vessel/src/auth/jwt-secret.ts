import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export const JWT_SECRET_KEY = 'jwt_secret';

/**
 * Resolves this vessel's own token-signing secret.
 *
 * Every vessel used to fall back to the same hardcoded string, which made
 * a session minted by one vessel verify on every other vessel in the
 * fleet. Cookies are scoped by host and ignore the port, so on a machine
 * running several vessels (a simulated fleet, or an operator with two
 * terminals behind one hostname) a login against one vessel was offered
 * to the next and passed signature checking there. The account then
 * resolved to nobody and the crew was told their account was inactive —
 * the visible symptom of what is really a shared-credential problem.
 *
 * Resolution order:
 *   1. JWT_SECRET, for operators who want to manage it themselves.
 *   2. A secret generated on this vessel's first boot and kept in its own
 *      config store, so each vessel diverges automatically with nothing
 *      to configure. Vessels are appliances that get provisioned by
 *      copying an image, so a default that must be changed by hand is a
 *      default that stays unchanged.
 *
 * Existing sessions stop resolving the first time a vessel generates its
 * own secret, which is a one-off re-login rather than a migration.
 */
export async function resolveJwtSecret(
  db: BetterSQLite3Database<typeof schema>,
): Promise<string> {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;

  const rows = await db
    .select()
    .from(schema.configStore)
    .where(eq(schema.configStore.key, JWT_SECRET_KEY));
  if (rows.length > 0 && rows[0].value) {
    try {
      const parsed = JSON.parse(rows[0].value);
      if (typeof parsed === 'string' && parsed.length > 0) return parsed;
    } catch {
      // Stored before this used JSON, or hand-edited: fall through and
      // reissue rather than signing with something unparseable.
    }
  }

  const generated = randomBytes(32).toString('hex');
  await db
    .insert(schema.configStore)
    .values({
      key: JWT_SECRET_KEY,
      value: JSON.stringify(generated),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.configStore.key,
      set: { value: JSON.stringify(generated), updatedAt: new Date().toISOString() },
    });
  return generated;
}
