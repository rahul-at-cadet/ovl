import { Injectable } from '@nestjs/common';

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

@Injectable()
export class SensorsService {
  /**
   * The original Go vessel (vessel/httpapi's handleFetchSensorData) only
   * ever returns sensor readings for a configured, reachable onboard
   * source — an unconfigured vessel gets a real "not configured" state,
   * never fabricated numbers. This Node edge node has no such source
   * (the Settings > Hardware Sensors tab isn't wired to anything real
   * yet), so the honest equivalent here is null: "Pre-fill from Sensors"
   * in ReportForm disables itself accordingly. Randomly generating GPS/
   * engine/wind readings — as this previously did on every poll — is
   * worse than no data, since a report officer could submit fabricated
   * instrument readings into a real ship's log believing they came from
   * hardware.
   */
  async getTelemetry(): Promise<TelemetryData | null> {
    return null;
  }
}
