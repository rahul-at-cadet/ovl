import { Injectable } from '@nestjs/common';

export interface VoyageData {
  voyageNumber: string;
  departurePort: string;
  arrivalPort: string;
  departureTime: string;
  eta: string;
  cargoTotalMt: number;
  draftFwdMeters: number;
  draftAftMeters: number;
}

@Injectable()
export class VmsService {
  /**
   * Fetches active voyage data from the Vessel Management System.
   * Mocked for Node.js edge node implementation.
   */
  async getActiveVoyage(): Promise<VoyageData> {
    return {
      voyageNumber: 'VOY-2026-08',
      departurePort: 'Singapore (SGSIN)',
      arrivalPort: 'Rotterdam (NLRTM)',
      departureTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
      eta: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days from now
      cargoTotalMt: 125000,
      draftFwdMeters: 14.5,
      draftAftMeters: 15.0,
    };
  }
}
