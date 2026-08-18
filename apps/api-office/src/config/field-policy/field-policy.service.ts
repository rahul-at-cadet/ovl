import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../../database/database.module';
import { Scope, ScopeType } from '../logic/scope';
import {
  SchemaField,
  diffSchemaFields,
  migrateFieldPolicy,
  hasEventConcept,
  EVENT_TYPE_CODES,
  filterSavePolicy,
  filterSavePrefill,
  filterSaveEvents,
} from '../logic/fieldPolicy';

export interface FieldPolicyView {
  schemaName: string;
  version: string;
  scope: Scope;
  fields: SchemaField[];
  eventTypes: string[];
  policy: Record<string, string>;
  prefill: Record<string, string>;
  events: Record<string, string[]>;
  migration?: { fromVersion: string; newFields: string[]; removedFields: string[] } | null;
}

@Injectable()
export class FieldPolicyService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  private scopeConditions(scopeType: string, scopeKey: string | undefined) {
    const conditions = [eq(schema.fieldPolicyAssignments.scopeType, scopeType)];
    if (scopeType === 'group' && scopeKey) {
      conditions.push(eq(schema.fieldPolicyAssignments.groupTag, scopeKey));
    } else if (scopeType === 'vessel' && scopeKey) {
      conditions.push(eq(schema.fieldPolicyAssignments.vesselId, scopeKey));
    }
    return conditions;
  }

  private parseContent(content: Buffer): { fields: SchemaField[]; sections?: string[] } {
    try {
      const parsed = JSON.parse(content.toString('utf-8'));
      return { fields: parsed.fields ?? [], sections: parsed.sections };
    } catch {
      return { fields: [] };
    }
  }

  async get(schemaName: string, scope: Scope): Promise<FieldPolicyView> {
    const versions = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaName, schemaName))
      .orderBy(desc(schema.schemaVersions.publishedAt));

    if (versions.length === 0) throw new NotFoundException('Schema not found');
    const latest = versions[0];
    const { fields } = this.parseContent(latest.content);
    const eventTypes = hasEventConcept(fields) ? EVENT_TYPE_CODES : [];

    const conditions = [
      eq(schema.fieldPolicyAssignments.schemaName, schemaName),
      eq(schema.fieldPolicyAssignments.schemaVersion, latest.version),
      ...this.scopeConditions(scope.type, scope.key),
    ];
    const rows = await this.db
      .select()
      .from(schema.fieldPolicyAssignments)
      .where(and(...conditions))
      .limit(1);
    const existing = rows[0];

    let policy = (existing?.policy as Record<string, string>) ?? {};
    let prefill = (existing?.prefill as Record<string, string>) ?? {};
    let events = (existing?.events as Record<string, string[]>) ?? {};
    let migration: FieldPolicyView['migration'] = null;

    // Migration assistant: only offered when no row exists yet for this
    // scope+version (an intentional empty save still creates a row, and
    // that row's mere existence means "don't ask again").
    if (!existing && versions.length > 1) {
      const previous = versions[1];
      const previousFields = this.parseContent(previous.content).fields;
      const diff = diffSchemaFields(previousFields, fields);

      const prevConditions = [
        eq(schema.fieldPolicyAssignments.schemaName, schemaName),
        eq(schema.fieldPolicyAssignments.schemaVersion, previous.version),
        ...this.scopeConditions(scope.type, scope.key),
      ];
      const prevRows = await this.db
        .select()
        .from(schema.fieldPolicyAssignments)
        .where(and(...prevConditions))
        .limit(1);
      const prevAssignment = prevRows[0];

      const migrated = migrateFieldPolicy(
        (prevAssignment?.policy as Record<string, string>) ?? {},
        (prevAssignment?.prefill as Record<string, string>) ?? {},
        (prevAssignment?.events as Record<string, string[]>) ?? {},
        diff,
      );
      policy = migrated.policy;
      prefill = migrated.prefill;
      events = migrated.events;
      migration = {
        fromVersion: previous.version,
        newFields: migrated.newFields,
        removedFields: migrated.removedFields,
      };
    }

    return {
      schemaName,
      version: latest.version,
      scope,
      fields,
      eventTypes,
      policy,
      prefill,
      events,
      migration,
    };
  }

  async save(
    schemaName: string,
    scope: Scope,
    policy: Record<string, string>,
    prefill: Record<string, string>,
    events: Record<string, string[]>,
  ): Promise<FieldPolicyView> {
    const versions = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaName, schemaName))
      .orderBy(desc(schema.schemaVersions.publishedAt))
      .limit(1);
    if (versions.length === 0) throw new NotFoundException('Schema not found');
    const latest = versions[0];
    const { fields } = this.parseContent(latest.content);

    const filteredPolicy = filterSavePolicy(fields, policy);
    const filteredPrefill = filterSavePrefill(fields, prefill);
    let filteredEvents: Record<string, string[]>;
    try {
      filteredEvents = filterSaveEvents(fields, events);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }

    const conditions = [
      eq(schema.fieldPolicyAssignments.schemaName, schemaName),
      eq(schema.fieldPolicyAssignments.schemaVersion, latest.version),
      ...this.scopeConditions(scope.type, scope.key),
    ];
    const existing = await this.db
      .select()
      .from(schema.fieldPolicyAssignments)
      .where(and(...conditions))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(schema.fieldPolicyAssignments)
        .set({
          policy: filteredPolicy,
          prefill: filteredPrefill,
          events: filteredEvents,
          updatedAt: new Date().toISOString(),
        })
        .where(and(...conditions));
    } else {
      await this.db.insert(schema.fieldPolicyAssignments).values({
        schemaName,
        schemaVersion: latest.version,
        scopeType: scope.type,
        groupTag: scope.type === 'group' ? scope.key ?? null : null,
        vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
        policy: filteredPolicy,
        prefill: filteredPrefill,
        events: filteredEvents,
        updatedAt: new Date().toISOString(),
      });
    }

    return this.get(schemaName, scope);
  }

  async listAssignments(schemaName: string) {
    const versions = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaName, schemaName))
      .orderBy(desc(schema.schemaVersions.publishedAt));

    const rows = await this.db
      .select()
      .from(schema.fieldPolicyAssignments)
      .where(eq(schema.fieldPolicyAssignments.schemaName, schemaName));

    const versionSet = new Set(versions.map((v) => v.version));

    return rows
      .filter((r) => versionSet.has(r.schemaVersion))
      .map((r) => ({
        scope: {
          type: r.scopeType as ScopeType,
          key: r.scopeType === 'group' ? r.groupTag ?? undefined : r.scopeType === 'vessel' ? r.vesselId ?? undefined : undefined,
        },
        schemaVersion: r.schemaVersion,
        updatedAt: r.updatedAt,
      }));
  }
}
