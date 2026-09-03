import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { SchemaVersionsService } from './schema-versions.service';

/**
 * Downloading the exact document that was published — ports
 * handleDownloadSchemaVersion.
 *
 * A REST route rather than a tRPC procedure so the browser saves a file
 * rather than JavaScript receiving a string, and the bytes are served
 * verbatim: a published version is immutable, and re-serialising it would
 * hand back a document differing from the one whose formatting an
 * operator may be comparing against.
 */
@Controller('schema-versions')
@UseGuards(AuthGuard)
export class SchemaVersionsController {
  constructor(private readonly schemaVersions: SchemaVersionsService) {}

  @Get(':schemaName/:version/download')
  async download(
    @Param('schemaName') schemaName: string,
    @Param('version') version: string,
    @Res() res: Response,
  ) {
    const bytes = await this.schemaVersions.getVersionBytes(schemaName, version);
    if (!bytes) throw new NotFoundException('No such schema version.');

    // Both segments become part of the filename, so they are reduced to
    // the characters a schema name and version actually use — a value
    // carrying quotes or a newline could otherwise forge headers.
    const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe(schemaName)}-${safe(version)}.json"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }
}
