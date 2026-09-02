import { readPositionForTest as readPosition } from '../vessels.service';

/**
 * Coordinate parsing for the fleet map. The schema stores position in
 * DDM form (ovl/schemas/ovd-3.13/log-abstract.json: Latitude_Degree as
 * `wholeNumber`, Latitude_Minutes as `decimal`, Latitude_North_South as
 * free `text` with no enumRef) — the degrees-and-decimal-minutes
 * convention standard in maritime and aviation use, where minutes run
 * 0–59.9999 and the hemisphere letter carries the sign.
 *
 * The schema itself declares no bounds on any of these, so every check
 * below is the application's responsibility rather than something a
 * validator upstream would have caught.
 */
describe('readPosition', () => {
  const pos = (latD: number, latM: number, latH: string, lonD: number, lonM: number, lonH: string) => ({
    Latitude_Degree: latD,
    Latitude_Minutes: latM,
    Latitude_North_South: latH,
    Longitude_Degree: lonD,
    Longitude_Minutes: lonM,
    Longitude_East_West: lonH,
  });

  describe('converts DDM to decimal degrees against known port positions', () => {
    // Published approximate port coordinates, used as fixtures so the
    // arithmetic is anchored to real places rather than to itself.
    it.each([
      ['Singapore', 1, 16, 'N', 103, 50, 'E', 1.2667, 103.8333],
      ['Rotterdam', 51, 55, 'N', 4, 29, 'E', 51.9167, 4.4833],
      ['Valparaiso (S/W)', 33, 2, 'S', 71, 37, 'W', -33.0333, -71.6167],
      ['Fremantle (S/E)', 31, 57, 'S', 115, 51, 'E', -31.95, 115.85],
      ['New York (N/W)', 40, 42, 'N', 74, 0, 'W', 40.7, -74.0],
    ])('%s', (_n, latD, latM, latH, lonD, lonM, lonH, wantLat, wantLon) => {
      const got = readPosition(pos(latD as number, latM as number, latH as string, lonD as number, lonM as number, lonH as string));
      expect(got).not.toBeNull();
      expect(got!.lat).toBeCloseTo(wantLat as number, 3);
      expect(got!.lon).toBeCloseTo(wantLon as number, 3);
    });
  });

  it('accepts the exact bounds of the coordinate system', () => {
    expect(readPosition(pos(90, 0, 'N', 180, 0, 'E'))).toEqual({ lat: 90, lon: 180 });
    expect(readPosition(pos(90, 0, 'S', 180, 0, 'W'))).toEqual({ lat: -90, lon: -180 });
  });

  it('plots Null Island rather than treating 0,0 as absent', () => {
    // A falsy-zero bug here would silently drop a legitimate position.
    expect(readPosition(pos(0, 0, 'N', 0, 0, 'E'))).toEqual({ lat: 0, lon: 0 });
  });

  it('rejects out-of-range degrees', () => {
    expect(readPosition(pos(500, 0, 'N', 999, 0, 'E'))).toBeNull();
    expect(readPosition(pos(91, 0, 'N', 20, 0, 'E'))).toBeNull();
    expect(readPosition(pos(45, 0, 'N', 181, 0, 'E'))).toBeNull();
  });

  it('rejects minutes at or beyond 60', () => {
    // 45°90' would otherwise resolve to a plausible-looking 46.5°.
    expect(readPosition(pos(45, 90, 'N', 20, 0, 'E'))).toBeNull();
    expect(readPosition(pos(45, 60, 'N', 20, 0, 'E'))).toBeNull();
    expect(readPosition(pos(45, 0, 'N', 20, 60, 'E'))).toBeNull();
    // ...but 59.9999 is a legitimate minute value.
    expect(readPosition(pos(45, 59.9999, 'N', 20, 59.9999, 'E'))).not.toBeNull();
  });

  it('rejects negative components — the hemisphere letter carries the sign', () => {
    expect(readPosition(pos(-25, 0, 'N', 20, 0, 'E'))).toBeNull();
    expect(readPosition(pos(25, -5, 'N', 20, 0, 'E'))).toBeNull();
  });

  it('rejects unrecognised hemisphere letters instead of assuming N/E', () => {
    // The field is free text (no enumRef), so "X" means the officer's
    // intent is unknown — not "north".
    expect(readPosition(pos(10, 0, 'X', 20, 0, 'E'))).toBeNull();
    expect(readPosition(pos(10, 0, 'N', 20, 0, 'Q'))).toBeNull();
    // E/W in the latitude slot is equally wrong.
    expect(readPosition(pos(10, 0, 'E', 20, 0, 'E'))).toBeNull();
  });

  it('accepts lowercase hemisphere letters', () => {
    // Free text, so case is the officer's choice.
    expect(readPosition(pos(33, 2, 's', 71, 37, 'w'))).toEqual(readPosition(pos(33, 2, 'S', 71, 37, 'W')));
  });

  it('rejects missing, non-numeric or empty sub-fields', () => {
    expect(readPosition({})).toBeNull();
    expect(readPosition(pos(10, 0, '', 20, 0, 'E'))).toBeNull();
    expect(readPosition({ ...pos(10, 0, 'N', 20, 0, 'E'), Latitude_Degree: '10' })).toBeNull();
    expect(readPosition({ ...pos(10, 0, 'N', 20, 0, 'E'), Latitude_Degree: NaN })).toBeNull();
  });
});
