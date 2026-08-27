import {
  InvalidFormSchemaError,
  diffFields,
  parseFormSchemaDocument,
  projectFields,
  referencedEnums,
  validateFormSchemaDocument,
  type FormSchemaDocument,
} from './form-schema-document';

const doc = (overrides: Partial<FormSchemaDocument> = {}): FormSchemaDocument => ({
  schemaName: 'bunker-report',
  version: '3.13',
  ovdVersion: '3.13',
  sections: ['header'],
  fields: [
    { name: 'IMO', label: 'IMO number', type: 'wholeNumber', section: 'header', schemaMandatory: true },
  ],
  ...overrides,
});

describe('validateFormSchemaDocument', () => {
  it('accepts a well-formed document', () => {
    expect(validateFormSchemaDocument(doc())).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, input) => {
    expect(validateFormSchemaDocument(input).valid).toBe(false);
  });

  it('requires schemaName and version', () => {
    const result = validateFormSchemaDocument({ fields: [{ name: 'a', type: 'text' }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining(['schemaName is required', 'version is required']),
    );
  });

  it('requires at least one field, because a form with no fields renders nothing', () => {
    expect(validateFormSchemaDocument(doc({ fields: [] })).errors).toContain(
      'fields must be a non-empty array',
    );
  });

  it('requires every field to have a type', () => {
    const result = validateFormSchemaDocument(
      doc({ fields: [{ name: 'IMO', type: '' } as never] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toMatch(/missing a type/);
  });

  /**
   * The failure most worth catching. Report values are stored in a name-keyed
   * JSON bag on both office and vessel, so two fields sharing a name means one
   * silently overwrites the other's answer — data loss that looks like a
   * rendering quirk.
   */
  it('rejects duplicate field names', () => {
    const result = validateFormSchemaDocument(
      doc({
        fields: [
          { name: 'IMO', type: 'text' },
          { name: 'IMO', type: 'wholeNumber' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('duplicate field name "IMO"');
  });

  it('rejects a field placed in a section the document never declares', () => {
    const result = validateFormSchemaDocument(
      doc({ sections: ['header'], fields: [{ name: 'IMO', type: 'text', section: 'ghost' }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toMatch(/not declared in sections/);
  });

  it('allows fields with no section at all', () => {
    expect(
      validateFormSchemaDocument(doc({ fields: [{ name: 'IMO', type: 'text' }] })).valid,
    ).toBe(true);
  });
});

describe('parseFormSchemaDocument', () => {
  it('parses valid JSON', () => {
    expect(parseFormSchemaDocument(JSON.stringify(doc())).schemaName).toBe('bunker-report');
  });

  it('reports malformed JSON distinctly from an invalid document', () => {
    expect(() => parseFormSchemaDocument('{oops')).toThrow(InvalidFormSchemaError);
    expect(() => parseFormSchemaDocument('{oops')).toThrow(/not valid JSON/);
  });

  it('reports every validation problem at once, not just the first', () => {
    expect(() => parseFormSchemaDocument('{"fields":[]}')).toThrow(/schemaName is required/);
  });
});

describe('projectFields', () => {
  it('preserves declaration order as ordinal, because that is render order', () => {
    const projected = projectFields(
      doc({
        fields: [
          { name: 'b', type: 'text' },
          { name: 'a', type: 'text' },
        ],
      }),
    );
    expect(projected.map((f) => [f.name, f.ordinal])).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });

  it('normalises absent optional properties to null rather than undefined', () => {
    const [field] = projectFields(doc({ fields: [{ name: 'IMO', type: 'text' }] }));
    expect(field.unit).toBeNull();
    expect(field.enumRef).toBeNull();
    expect(field.maxLength).toBeNull();
    expect(field.schemaMandatory).toBe(false);
    expect(field.appliesToEvents).toEqual([]);
  });

  /**
   * The forward-compatibility escape hatch. The OVD spec grows, and a
   * projection that silently discarded unrecognised properties would make the
   * row view quietly disagree with the document it came from.
   */
  it('keeps unrecognised properties in attributes instead of dropping them', () => {
    const [field] = projectFields(
      doc({
        fields: [
          { name: 'IMO', type: 'text', someFutureOvdProperty: 42, anotherOne: { nested: true } },
        ],
      }),
    );
    expect(field.attributes).toEqual({ someFutureOvdProperty: 42, anotherOne: { nested: true } });
  });

  it('does not put known properties into attributes', () => {
    const [field] = projectFields(
      doc({ fields: [{ name: 'IMO', type: 'text', unit: 'mt', enumRef: 'fuel-types' }] }),
    );
    expect(field.attributes).toEqual({});
    expect(field.unit).toBe('mt');
  });
});

describe('diffFields', () => {
  const before = [
    { name: 'IMO', type: 'wholeNumber', maxLength: 7 },
    { name: 'BDN', type: 'text' },
  ];

  it('detects additions and removals', () => {
    const diff = diffFields(before, [
      { name: 'IMO', type: 'wholeNumber', maxLength: 7 },
      { name: 'NewField', type: 'text' },
    ]);
    expect(diff.added).toEqual(['NewField']);
    expect(diff.removed).toEqual(['BDN']);
    expect(diff.changed).toEqual([]);
  });

  it('names the properties that changed, not just the field', () => {
    const diff = diffFields(before, [
      { name: 'IMO', type: 'text', maxLength: 9 },
      { name: 'BDN', type: 'text' },
    ]);
    expect(diff.changed).toEqual([{ name: 'IMO', properties: ['maxLength', 'type'] }]);
  });

  it('is not fooled by key order, since that is not a real change', () => {
    const diff = diffFields(
      [{ name: 'IMO', type: 'text', maxLength: 7 }],
      [{ maxLength: 7, type: 'text', name: 'IMO' }],
    );
    expect(diff.changed).toEqual([]);
  });

  it('reports nothing for identical inputs', () => {
    expect(diffFields(before, before)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('referencedEnums', () => {
  it('deduplicates and sorts, so the result is stable', () => {
    expect(
      referencedEnums(
        doc({
          fields: [
            { name: 'a', type: 'text', enumRef: 'fuel-types' },
            { name: 'b', type: 'text', enumRef: 'event-types' },
            { name: 'c', type: 'text', enumRef: 'fuel-types' },
            { name: 'd', type: 'text' },
          ],
        }),
      ),
    ).toEqual(['event-types', 'fuel-types']);
  });
});
