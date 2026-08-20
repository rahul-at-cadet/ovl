import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';

export interface TelemetryData {
  gps: {
    lat: number;
    lng: number;
    speedKnots: number;
    heading: number;
  };
  engine: {
    rpm: number;
    temperatureCelsius: number;
    fuelFlowRateM3PerHour: number;
  };
  environment: {
    windSpeedKnots: number;
    windDirection: number;
    seaState: number;
  };
  timestamp: string;
}

export interface SensorSourceView {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  configured: boolean;
}

interface SensorSourceRecord {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

const CONFIG_KEY = 'sensor_source';
const FETCH_TIMEOUT_MS = 10_000;

function maskApiKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `${'•'.repeat(key.length - 4)}${key.slice(-4)}`;
}

@Injectable()
export class SensorsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  private async readSource(): Promise<SensorSourceRecord | null> {
    const rows = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, CONFIG_KEY));
    if (!rows[0]) return null;
    try {
      return JSON.parse(rows[0].value) as SensorSourceRecord;
    } catch {
      return null;
    }
  }

  /** Master-only view, API key masked — mirrors handleGetSensorSource. */
  async getSource(): Promise<SensorSourceView> {
    const source = await this.readSource();
    if (!source) return { baseUrl: '', apiKey: '', enabled: false, configured: false };
    return { baseUrl: source.baseUrl, apiKey: maskApiKey(source.apiKey), enabled: source.enabled, configured: true };
  }

  async saveSource(baseUrl: string, apiKey: string, enabled: boolean): Promise<SensorSourceView> {
    const record: SensorSourceRecord = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), enabled };
    const now = new Date().toISOString();
    await this.db
      .insert(schema.configStore)
      .values({ key: CONFIG_KEY, value: JSON.stringify(record), updatedAt: now })
      .onConflictDoUpdate({ target: schema.configStore.key, set: { value: JSON.stringify(record), updatedAt: now } });
    return { baseUrl: record.baseUrl, apiKey: maskApiKey(record.apiKey), enabled: record.enabled, configured: true };
  }

  /** Checks connectivity without saving — Settings' "Test connection" action. */
  async testSource(baseUrl: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    const trimmedBaseUrl = baseUrl.trim();
    let resolvedApiKey = apiKey.trim();
    if (!resolvedApiKey) {
      const existing = await this.readSource();
      resolvedApiKey = existing?.apiKey ?? '';
    }
    if (!trimmedBaseUrl) return { ok: false, message: 'baseUrl is required' };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(new URL('telemetry', trimmedBaseUrl.endsWith('/') ? trimmedBaseUrl : trimmedBaseUrl + '/'), {
        headers: { Authorization: `Bearer ${resolvedApiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false, message: `Sensor source returned status ${res.status}` };
      return { ok: true, message: 'Connected — the sensor source responded successfully.' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Request failed' };
    }
  }

  /**
   * The original Go vessel (vessel/httpapi's handleFetchSensorData) only
   * ever returns sensor readings for a configured, reachable onboard
   * source — an unconfigured vessel gets a real "not configured" state,
   * never fabricated numbers. Randomly generating GPS/engine/wind
   * readings — as this previously did on every poll, unconditionally —
   * is worse than no data, since a report officer could submit
   * fabricated instrument readings into a real ship's log believing
   * they came from hardware. Mirrors that: no configured+enabled source
   * means null, and an unreachable configured source also means null
   * rather than stale/fake data.
   */
  async getTelemetry(): Promise<TelemetryData | null> {
    const source = await this.readSource();
    if (!source || !source.enabled || !source.baseUrl) return null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(new URL('telemetry', source.baseUrl.endsWith('/') ? source.baseUrl : source.baseUrl + '/'), {
        headers: { Authorization: `Bearer ${source.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.gps || !data.engine || !data.environment) return null;
      return data as TelemetryData;
    } catch {
      return null;
    }
  }
}
