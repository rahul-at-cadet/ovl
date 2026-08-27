import { formSchemaChecksum } from '@ovl/vessel-database';

/**
 * Golden values shared with the other copy of this function.
 *
 * `@ovl/database` and `@ovl/vessel-database` each carry their own
 * implementation — the office package pulls in `pg`, which has no business on
 * a vessel running SQLite. The duplication is deliberate; silent divergence is
 * not.
 *
 * These fixtures pin the two together. If one copy changes and the other does
 * not, the hashes stop matching and this fails — instead of every sync quietly
 * failing its checksum check and looking like a corrupted satellite link.
 *
 * Change the algorithm and you must change BOTH files and BOTH specs. A golden
 * value edited to match whatever the code now produces has stopped testing
 * anything.
 */
describe('form schema checksum (golden values shared across packages)', () => {
  const cases: Array<[string, unknown, string]> = [
    [
      'a schema document',
      { schemaName: 'x', version: '1.0', fields: [{ name: 'a', type: 'text' }] },
      'sha256:3f6f9fe995bf274aaf37a7e1e344f8259df60d3dc95fd80a112694257bb5e205',
    ],
    [
      'unsorted keys',
      { b: 1, a: 2 },
      'sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772',
    ],
    [
      'nested arrays and nulls',
      { nested: { z: [1, 2, { q: null }], a: 'x' } },
      'sha256:056c6f183f1a93ae3b2e277ca582d3d50cc434431fbf1100daa259fb399988ad',
    ],
    ['an empty array', [], 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
    ['an empty object', {}, 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
  ];

  it.each(cases)('hashes %s to the shared golden value', (_label, document, expected) => {
    expect(formSchemaChecksum(document)).toBe(expected);
  });

  it('is stable under key reordering, because object key order carries no meaning', () => {
    expect(formSchemaChecksum({ a: 1, b: 2 })).toBe(formSchemaChecksum({ b: 2, a: 1 }));
  });

  it('is NOT stable under array reordering, because field order drives render order', () => {
    expect(formSchemaChecksum([1, 2])).not.toBe(formSchemaChecksum([2, 1]));
  });
});
