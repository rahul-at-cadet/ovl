/**
 * Tenant provisioning CLI.
 *
 *   npm run tenant:list          --workspace api-office
 *   npm run tenant:provision     --workspace api-office -- --name "Northstar Shipping"
 *   npm run tenant:assign        --workspace api-office -- --user <supertokensUserId> --slug northstar_shipping
 *   npm run tenant:suspend       --workspace api-office -- --slug northstar_shipping
 *   npm run tenant:migrate       --workspace api-office
 *   npm run tenant:migrate:status --workspace api-office
 *   npm run tenant:destroy       --workspace api-office -- --slug northstar_shipping --confirm "drop tenant northstar_shipping"
 *
 * Requires ADMIN_DATABASE_URL — a role that may CREATE SCHEMA, CREATE ROLE and
 * GRANT. The serving API deliberately does not have one.
 *
 * Built on `NestFactory.createApplicationContext`, so it runs the real
 * providers with the real configuration rather than a parallel script that
 * reimplements provisioning and drifts from it.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { TenantProvisioningService } from '../tenant-provisioning.service';
import { TenantRegistryService } from '../tenant-registry.service';
import { TenantMigrationRunnerService } from '../tenant-migration-runner.service';

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

const require_ = (args: Args, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
};

/**
 * CLI output goes to stdout directly, not through Nest's Logger.
 *
 * The container is started with the 'log' level suppressed so that framework
 * chatter and startup seeding do not drown the result — which also means
 * logger.log() would swallow this command's own output. Anything the operator
 * asked for is printed; anything the framework has to say is a log line.
 */
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const logger = new Logger('tenant-cli');
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) {
    out('Usage: tenant-cli <list|provision|assign|suspend|activate|migrate|migrate-status|destroy> [--flags]');
    process.exitCode = 1;
    return;
  }

  // `logger: false` keeps Nest's boot banner out of CLI output; errors still
  // surface through the catch below.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const provisioning = app.get(TenantProvisioningService);
    const registry = app.get(TenantRegistryService);

    switch (command) {
      case 'list': {
        const all = await registry.list();
        if (all.length === 0) {
          out('No tenants registered.');
          break;
        }
        for (const tenant of all) {
          out(`${tenant.slug.padEnd(24)} ${tenant.status.padEnd(14)} ${tenant.schemaName}`);
        }
        break;
      }

      case 'provision': {
        const name = require_(args, 'name');
        const slug = typeof args.slug === 'string' ? args.slug : undefined;
        const tenant = await provisioning.provision({ name, slug });
        out(`Provisioned ${tenant.slug} -> ${tenant.schemaName} (id ${tenant.tenantId})`);
        break;
      }

      case 'assign': {
        const supertokensUserId = require_(args, 'user');
        const slug = require_(args, 'slug');
        const tenant = await registry.forSlug(slug);
        if (!tenant) throw new Error(`No active tenant with slug ${slug}`);
        await provisioning.assignUser(supertokensUserId, tenant.tenantId);
        out(`Assigned user ${supertokensUserId} to ${slug}`);
        break;
      }

      case 'suspend':
      case 'activate': {
        const slug = require_(args, 'slug');
        await provisioning.setStatus(slug, command === 'suspend' ? 'suspended' : 'active');
        out(`Tenant ${slug} is now ${command === 'suspend' ? 'suspended' : 'active'}`);
        break;
      }

      case 'migrate': {
        const runner = app.get(TenantMigrationRunnerService);
        const results = await runner.migrateAll();
        const changed = results.filter((r) => r.applied.length > 0);
        const failed = results.filter((r) => r.error);

        for (const r of changed) out(`${r.slug.padEnd(24)} applied ${r.applied.join(', ')}`);
        for (const r of failed) out(`${r.slug.padEnd(24)} FAILED  ${r.error}`);
        if (changed.length === 0 && failed.length === 0) out('Every tenant is up to date.');
        // A fan-out is not atomic across tenants, so a partial run is a real
        // outcome the caller has to see rather than a silent success.
        if (failed.length > 0) process.exitCode = 1;
        break;
      }

      case 'migrate-status': {
        const runner = app.get(TenantMigrationRunnerService);
        const rows = await runner.status();
        if (rows.length === 0) {
          out('No tenants registered.');
          break;
        }
        out('TENANT'.padEnd(24) + 'APPLIED'.padEnd(10) + 'PENDING'.padEnd(24) + 'DRIFTED');
        for (const r of rows) {
          out(
            r.slug.padEnd(24) +
              String(r.applied.length).padEnd(10) +
              (r.pending.join(',') || '-').padEnd(24) +
              (r.drifted.join(',') || '-'),
          );
        }
        break;
      }

      case 'destroy': {
        const slug = require_(args, 'slug');
        const confirm = require_(args, 'confirm');
        await provisioning.destroy(slug, confirm as `drop tenant ${string}`);
        out(`Destroyed ${slug}`);
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
