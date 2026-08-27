import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MasterCatalogService } from './master-catalog.service';
import { validateFormSchemaDocument, type FormSchemaDocument } from './form-schema-document';

/**
 * Seeds the master catalogue from the curated OVD documents shipped in the repo.
 *
 * The JSON files under `src/schemas` are the *origin* of the catalogue, not its
 * home. Once seeded, the database is authoritative: a super admin publishes new
 * versions through the UI, and this seeder never touches a schema name that
 * already has a version. Deleting a file will not remove anything already
 * published, which is deliberate — the catalogue outlives the repo layout.
 *
 * Runs at boot and is idempotent, so a fresh database comes up with a populated
 * catalogue instead of an empty picker. It is a no-op on every subsequent boot.
 */
@Injectable()
export class CuratedCatalogueSeederService implements OnModuleInit {
  private readonly logger = new Logger(CuratedCatalogueSeederService.name);

  constructor(private readonly master: MasterCatalogService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      // Never block boot on seeding. A database that is not yet bootstrapped —
      // no `platform` schema, no publisher role — is a normal state during
      // setup, and an API that refuses to start makes that harder to fix, not
      // easier.
      this.logger.warn(
        `Skipped curated catalogue seeding: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async seed(): Promise<{ seeded: string[]; skipped: string[] }> {
    const dir = join(process.cwd(), 'src', 'schemas');
    const seeded: string[] = [];
    const skipped: string[] = [];

    if (!existsSync(dir)) {
      this.logger.warn(`No curated schemas directory at ${dir}`);
      return { seeded, skipped };
    }

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const path = join(dir, file);

      let document: FormSchemaDocument;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const validation = validateFormSchemaDocument(parsed);
        if (!validation.valid) {
          this.logger.error(`Curated schema ${file} is invalid: ${validation.errors.join('; ')}`);
          continue;
        }
        document = parsed as FormSchemaDocument;
      } catch (error) {
        this.logger.error(
          `Could not read curated schema ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const wasSeeded = await this.master.seedIfAbsent(document, titleFor(document.schemaName));
      if (wasSeeded) {
        seeded.push(`${document.schemaName}@${document.version}`);
        this.logger.log(`Seeded master schema ${document.schemaName}@${document.version}`);
      } else {
        skipped.push(`${document.schemaName}@${document.version}`);
      }
    }

    if (seeded.length === 0) {
      this.logger.log(`Master catalogue already populated (${skipped.length} schemas present)`);
    }
    return { seeded, skipped };
  }
}

/** "bunker-report" -> "Bunker Report". Cosmetic; a super admin can rename it later. */
function titleFor(schemaName: string): string {
  return schemaName
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
