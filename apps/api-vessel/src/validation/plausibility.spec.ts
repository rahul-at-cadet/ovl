import { evaluatePlausibilityRules, RULE_POSITION_CONSISTENCY, RULE_POSITION_REQUIRED } from './plausibility';
import { validationConfigFor } from './config';
import { ValidationReport } from './types';

const config = validationConfigFor('log-abstract');

function report(fields: Record<string, unknown>): ValidationReport {
  return {
    reportId: 'r1',
    versionNo: 1,
    schemaName: 'log-abstract',
    eventType: 'Arrival',
    eventTime: new Date('2026-08-29T00:00:00Z'),
    fields,
  };
}

const ruleIds = (fs: { ruleId: string }[]) => fs.map((f) => f.ruleId);

describe('positionRules — empty vs invalid hemisphere', () => {
  it('does not report a consistency error for a hemisphere left blank', () => {
    const findings = evaluatePlausibilityRules(
      report({ Mode: 'InPort', Latitude_North_South: '', Longitude_East_West: '' }),
      config,
    );
    expect(findings.filter((f) => f.ruleId === RULE_POSITION_CONSISTENCY)).toEqual([]);
  });

  it('still reports a consistency error for a genuinely invalid letter', () => {
    const findings = evaluatePlausibilityRules(
      report({ Mode: 'InPort', Latitude_Degree: 10, Latitude_North_South: 'X', Longitude_Degree: 20, Longitude_East_West: 'E' }),
      config,
    );
    expect(ruleIds(findings)).toContain(RULE_POSITION_CONSISTENCY);
  });

  it('treats a blank hemisphere at sea as missing, not as present-and-valid', () => {
    const findings = evaluatePlausibilityRules(
      report({ Mode: 'Sailing', Latitude_Degree: 10, Latitude_North_South: '', Longitude_Degree: 20, Longitude_East_West: '' }),
      config,
    );
    expect(ruleIds(findings)).toContain(RULE_POSITION_REQUIRED);
  });
});

describe('evaluatePlausibilityRules — policy awareness', () => {
  const invalid = report({
    Mode: 'InPort',
    Latitude_Degree: 10,
    Latitude_North_South: 'X',
    Longitude_Degree: 20,
    Longitude_East_West: 'E',
  });

  it('reports against a visible field', () => {
    const findings = evaluatePlausibilityRules(invalid, config, () => false);
    expect(ruleIds(findings)).toContain(RULE_POSITION_CONSISTENCY);
  });

  it('suppresses a finding naming a field the policy hides', () => {
    const findings = evaluatePlausibilityRules(invalid, config, (n) => n === 'Latitude_North_South');
    expect(findings.filter((f) => f.field === 'Latitude_North_South')).toEqual([]);
  });

  it('keeps findings that name no single field', () => {
    const atSea = report({ Mode: 'Sailing' });
    const findings = evaluatePlausibilityRules(atSea, config, () => true);
    expect(ruleIds(findings)).toContain(RULE_POSITION_REQUIRED);
  });
});
