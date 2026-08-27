/**
 * Master form-schema catalogue CLI.
 *
 *   npm run catalogue:seed            --workspace api-office
 *   npm run catalogue:list            --workspace api-office
 *   npm run catalogue:admins          --workspace api-office
 *   npm run catalogue:grant-admin     --workspace api-office -- --user <stUserId> --email a@b.c
 *   npm run catalogue:revoke-admin    --workspace api-office -- --user <stUserId>
 *
 * Super admin membership is granted here rather than through the API on
 * purpose: `ovl_api` can read platform.super_admins but not write it, so a
 * compromised request path cannot promote anyone. Requires ADMIN_DATABASE_URL.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { MasterCatalogService } from '../master-catalog.service';
import { CuratedCatalogueSeederService } from '../curated-catalogue-seeder.service';
import { SuperAdminService } from '../../tenancy/super-admin.service';

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
};

const required = (args: Args, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
};

/** Straight to stdout — the Nest logger runs with 'log' suppressed here. */
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const logger = new Logger('catalogue-cli');
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) {
    out('Usage: catalogue <seed|list|admins|grant-admin|revoke-admin> [--flags]');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    switch (command) {
      case 'seed': {
        const result = await app.get(CuratedCatalogueSeederService).seed();
        out(`Seeded:  ${result.seeded.length ? result.seeded.join(', ') : '(none)'}`);
        out(`Already present: ${result.skipped.length ? result.skipped.join(', ') : '(none)'}`);
        break;
      }

      case 'list': {
        const schemas = await app.get(MasterCatalogService).listSchemas();
        if (schemas.length === 0) {
          out('Master catalogue is empty. Run `catalogue seed`.');
          break;
        }
        out('SCHEMA'.padEnd(22) + 'VERSION'.padEnd(10) + 'STATUS'.padEnd(12) + 'FIELDS');
        for (const s of schemas) {
          out(
            s.schemaName.padEnd(22) +
              s.version.padEnd(10) +
              s.status.padEnd(12) +
              String(s.fieldCount),
          );
        }
        break;
      }

      case 'admins': {
        const admins = await app.get(SuperAdminService).list();
        if (admins.length === 0) {
          out('No platform super admins. Grant one with `catalogue grant-admin`.');
          break;
        }
        for (const a of admins) {
          out(`${a.email.padEnd(32)} ${a.supertokensUserId}`);
        }
        break;
      }

      case 'grant-admin': {
        const user = required(args, 'user');
        const email = required(args, 'email');
        const note = typeof args.note === 'string' ? args.note : undefined;
        await app.get(SuperAdminService).grant(user, email, { note });
        out(`Granted platform super admin to ${email}`);
        break;
      }

      case 'revoke-admin': {
        const user = required(args, 'user');
        const removed = await app.get(SuperAdminService).revoke(user);
        out(removed ? `Revoked ${user}` : `${user} was not a super admin`);
        break;
      }

      default:
        logger.error(`Unknown command: ${command}`);
        process.exitCode = 1;
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
