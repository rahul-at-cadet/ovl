import { UnsupportedBundleError, WIRE_VERSION, decodeBundle, schemaConfigFor } from './config-wire';

const validBundle = {
  wireVersion: 1,
  bundleId: 'b-1',
  versionNo: 7,
  publishedAt: '2026-09-02T00:00:00.000Z',
  schemas: [
    {
      schemaName: 'log-abstract',
      version: '1.0',
      policy: { Latitude_Degree: 'companyMandatory' },
      prefill: {},
      events: { Latitude_Degree: ['NOON'] },
    },
  ],
};

describe('decodeBundle', () => {
  it('accepts the current wire version', () => {
    const b = decodeBundle(JSON.stringify(validBundle));
    expect(b.wireVersion).toBe(WIRE_VERSION);
    expect(b.schemas).toHaveLength(1);
  });

  it('refuses a version from a newer office', () => {
    // The case the gate exists for: an older vessel meeting a newer
    // office must fall back to defaults, not half-apply a shape it
    // cannot vouch for.
    const newer = { ...validBundle, wireVersion: WIRE_VERSION + 1 };
    expect(() => decodeBundle(JSON.stringify(newer))).toThrow(UnsupportedBundleError);
    expect(() => decodeBundle(JSON.stringify(newer))).toThrow(/unsupported config bundle wire version 2/);
  });

  it('refuses a pre-format bundle, whether the field is 0 or absent', () => {
    // A raw pre-configwire document decodes to wireVersion 0 in Go and
    // to undefined here; both mean "predates the format".
    expect(() => decodeBundle(JSON.stringify({ ...validBundle, wireVersion: 0 }))).toThrow(UnsupportedBundleError);
    const { wireVersion, ...withoutVersion } = validBundle;
    expect(() => decodeBundle(JSON.stringify(withoutVersion))).toThrow(UnsupportedBundleError);
  });

  it('refuses a non-numeric version rather than coercing it', () => {
    expect(() => decodeBundle(JSON.stringify({ ...validBundle, wireVersion: '1' }))).toThrow(UnsupportedBundleError);
  });

  it('reports malformed JSON as an unusable bundle, not a crash', () => {
    expect(() => decodeBundle('{not json')).toThrow(UnsupportedBundleError);
    expect(() => decodeBundle('null')).toThrow(UnsupportedBundleError);
    expect(() => decodeBundle('[]')).toThrow(/wire version/);
  });

  it('tolerates a bundle with no schemas array', () => {
    const { schemas, ...noSchemas } = validBundle;
    expect(decodeBundle(JSON.stringify(noSchemas)).schemas).toEqual([]);
  });
});

describe('schemaConfigFor', () => {
  const bundle = decodeBundle(JSON.stringify(validBundle));

  it('matches on the bare schema name', () => {
    expect(schemaConfigFor(bundle, 'log-abstract')?.version).toBe('1.0');
  });

  it('tolerates the registry\'s .json-suffixed name', () => {
    // Office stores bare names; the vessel registry keys on the
    // filename. That normalisation predates this module and is kept.
    expect(schemaConfigFor(bundle, 'log-abstract.json')?.version).toBe('1.0');
  });

  it('returns undefined for a schema the bundle does not cover', () => {
    expect(schemaConfigFor(bundle, 'bunker-report.json')).toBeUndefined();
  });
});
