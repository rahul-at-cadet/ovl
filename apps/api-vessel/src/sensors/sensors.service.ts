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
   * Fetches real-time telemetry from on-board NMEA2000 and Modbus sensors.
   * In this Node implementation, we mock the data to simulate actual hardware.
   */
  async getTelemetry(): Promise<TelemetryData> {
    // Generate realistic fluctuating telemetry data
    const baseLat = 35.6895; // e.g. near Tokyo
    const baseLng = 139.6917;
    
    // Slight jitter to simulate movement
    const jitter = () => (Math.random() - 0.5) * 0.001;

    return {
      gps: {
        lat: baseLat + jitter(),
        lng: baseLng + jitter(),
        speedKnots: 14.2 + (Math.random() * 0.5),
        heading: 85 + (Math.random() * 2),
      },
      engine: {
        rpm: 950 + Math.floor(Math.random() * 20),
        temperatureCelsius: 82.5 + Math.random(),
        fuelFlowRateM3PerHour: 2.1 + (Math.random() * 0.1),
      },
      environment: {
        windSpeedKnots: 12 + Math.random() * 5,
        windDirection: 45 + Math.random() * 10,
        seaState: 3, // 0-9 scale
      },
      timestamp: new Date().toISOString(),
    };
  }
}
