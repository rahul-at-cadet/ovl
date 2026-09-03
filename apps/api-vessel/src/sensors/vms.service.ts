import { Inject, Injectable, ConflictException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { ConflictError, NotFoundError } from '../common/app-error';

export interface VmsSourceView {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  configured: boolean;
}

interface VmsSourceRecord {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

const VMS_CONFIG_KEY = 'vms_source';
const VMS_FETCH_TIMEOUT_MS = 10_000;
const VMS_MAX_RESPONSE_BYTES = 1 << 20; // 1 MiB, mirrors vmsclient's maxResponseBytes

function maskApiKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

// Ports vms.go's vmsFieldMapFor — the VMS-key -> schema-field mapping,
// Direct-only (unlike sensors' own field map, VMS reference data has no
// lat/long position concept to split into a DMS triple). Only
// log-abstract has a curated one; every other schema gets an empty map,
// a real reachable "nothing to populate" state, not an error.
const LOG_ABSTRACT_VMS_FIELD_MAP: Record<string, string> = {
  previous_port_unlocode: 'Previous_Port_of_Call',
  next_port_unlocode: 'Next_Port_of_Call',
  voyage_from_unlocode: 'Voyage_From',
  voyage_to_unlocode: 'Voyage_To',
  voyage_type: 'Voyage_Type',
  voyage_number: 'Voyage_Number',
  eta: 'ETA',
  rta: 'RTA',
  speed_order: 'Speed_Order',
  charter_type: 'Charter_Type',
  carrier_code: 'Carrier_Code',
  carrier_name: 'Carrier_Name',
  service_name: 'Service',
  voyage_stage: 'Voyage_Stage',
  voyage_leg: 'Voyage_Leg',
  voyage_leg_type: 'Voyage_Leg_Type',
  port_to_port_id: 'Port_To_Port_Id',
  area_from: 'Area_From',
  area_to: 'Area_To',
  cargo_weight_mt: 'Cargo_Mt',
  deadweight_carried_mt: 'Deadweight_Carried',
  cargo_volume_m3: 'Cargo_M3',
  passengers: 'Passengers',
  crew: 'Crew',
  containers_full_teu: 'Cargo_Total_Full_TEU',
  containers_reefer_teu: 'Cargo_Reefer_TEU',
  vehicles_ceu: 'Cargo_CEU',
};

function vmsFieldMapFor(schemaName: string): Record<string, string> | null {
  return schemaName === 'log-abstract.json' ? LOG_ABSTRACT_VMS_FIELD_MAP : null;
}

// Ports normalizeVMSDateTime: eta/rta arrive as RFC3339 on the wire (the
// correct generic contract for a third-party VMS integrator) but this
// app's own dateTime fields are edited/stored as "yyyy-MM-dd HH:mm" —
// converts, and passes non-string/unparseable values through unchanged
// so the officer can still see and correct a raw value rather than lose
// it silently.
function normalizeVmsDateTime(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

@Injectable()
export class VmsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  private async readSource(): Promise<VmsSourceRecord | null> {
    const rows = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, VMS_CONFIG_KEY));
    if (!rows[0]) return null;
    try {
      return JSON.parse(rows[0].value) as VmsSourceRecord;
    } catch {
      return null;
    }
  }

  /** Master-only view, API key masked — mirrors handleGetVMSSource. */
  async getSource(): Promise<VmsSourceView> {
    const source = await this.readSource();
    if (!source) return { baseUrl: '', apiKey: '', enabled: false, configured: false };
    return { baseUrl: source.baseUrl, apiKey: maskApiKey(source.apiKey), enabled: source.enabled, configured: true };
  }

  /** Mirrors handleSaveVMSSource. Caller validates baseUrl/apiKey are non-empty. */
  async saveSource(baseUrl: string, apiKey: string, enabled: boolean): Promise<VmsSourceView> {
    const record: VmsSourceRecord = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), enabled };
    const now = new Date().toISOString();
    await this.db
      .insert(schema.configStore)
      .values({ key: VMS_CONFIG_KEY, value: JSON.stringify(record), updatedAt: now })
      .onConflictDoUpdate({ target: schema.configStore.key, set: { value: JSON.stringify(record), updatedAt: now } });
    return { baseUrl: record.baseUrl, apiKey: maskApiKey(record.apiKey), enabled: record.enabled, configured: true };
  }

  /**
   * Checks connectivity without saving — Settings' "Test connection"
   * action. Mirrors handleTestVMSSource: a blank apiKey falls back to
   * the already-stored one (the UI can never show the real key back for
   * re-editing, so leaving it blank means "reuse what's saved"). A
   * reachable-but-rejecting VMS is a normal {ok:false} result, not a
   * thrown error — only a genuinely missing baseUrl is a caller mistake.
   */
  async testSource(baseUrl: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) return { ok: false, message: 'baseUrl is required' };
    let resolvedApiKey = apiKey.trim();
    if (!resolvedApiKey) {
      const existing = await this.readSource();
      resolvedApiKey = existing?.apiKey ?? '';
    }
    if (!resolvedApiKey) return { ok: false, message: 'apiKey is required' };

    try {
      const voyageData = await fetchVoyageData(trimmedBaseUrl, resolvedApiKey, new Date());
      const fieldCount = Object.keys(voyageData).length;
      return { ok: true, message: `Connected — the VMS responded with ${fieldCount} field(s).` };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Request failed' };
    }
  }

  /**
   * Mirrors handleFetchVMSData: the report form's "Fetch voyage data"
   * button. Only log-abstract has a field mapping; a source that isn't
   * configured+enabled is a real, expected state (409-equivalent), not
   * a server error; an unreachable/failing VMS is a bad-gateway-
   * equivalent. Only keys the VMS actually returned end up in the
   * result — a field it never sent stays absent, never null/zero-filled.
   */
  async fetchFieldsForReport(schemaName: string, eventTime: Date): Promise<Record<string, unknown>> {
    const fieldMap = vmsFieldMapFor(schemaName);
    if (!fieldMap) throw new NotFoundError(`${schemaName} has no VMS field mapping`);

    const source = await this.readSource();
    if (!source || !source.enabled) {
      throw new ConflictError('no VMS source is configured — set one up in Settings');
    }

    let voyageData: Record<string, unknown>;
    try {
      voyageData = await fetchVoyageData(source.baseUrl, source.apiKey, eventTime);
    } catch (err: any) {
      throw new BadGatewayException(`fetch VMS data: ${err?.message || 'request failed'}`);
    }

    const fields: Record<string, unknown> = {};
    for (const [vmsKey, fieldName] of Object.entries(fieldMap)) {
      if (!(vmsKey in voyageData)) continue;
      const value = voyageData[vmsKey];
      fields[fieldName] = vmsKey === 'eta' || vmsKey === 'rta' ? normalizeVmsDateTime(value) : value;
    }
    return fields;
  }
}

/**
 * Ports vmsclient.Client.FetchVoyageData — the outbound HTTP call to the
 * third-party VMS. No schema knowledge here at all, matching the
 * original's package split: this returns the raw voyageData map
 * untouched, field-mapping happens one layer up.
 */
async function fetchVoyageData(baseUrl: string, apiKey: string, at: Date): Promise<Record<string, unknown>> {
  const url = new URL('voyage-data', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('at', at.toISOString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VMS_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`vmsclient: VMS returned status ${res.status}`);

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > VMS_MAX_RESPONSE_BYTES) {
    throw new Error('vmsclient: response too large');
  }
  const text = await res.text();
  if (text.length > VMS_MAX_RESPONSE_BYTES) throw new Error('vmsclient: response too large');

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('vmsclient: malformed JSON response');
  }
  const voyageData = (body as { voyageData?: unknown } | null)?.voyageData;
  if (!voyageData || typeof voyageData !== 'object') {
    throw new Error('vmsclient: response missing voyageData');
  }
  return voyageData as Record<string, unknown>;
}
