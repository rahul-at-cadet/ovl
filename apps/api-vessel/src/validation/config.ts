import { AlternatingGroup, RobSeries, ValidationConfig } from './types';

// Ports ovl/pkg/validation/config.go's DefaultEventGroups. Spellings
// (with/without spaces) are copied verbatim from
// schemas/ovd-3.13/enums/event-types.json — inconsistent on purpose,
// matching the real enum values officers actually pick.
export function defaultEventGroups(): AlternatingGroup[] {
  return [
    { name: 'arrivalDeparture', stage0: ['Arrival', 'ArrivalSTS'], stage1: ['Departure', 'DepartureSTS'] },
    { name: 'seaPassage', stage0: ['BOSP', 'BeginOfSeaPassage', 'FAOP', 'FullAheadOnPassage'], stage1: ['EOSP', 'EndOfSeaPassage'] },
    { name: 'shifting', stage0: ['BeginOfShifting'], stage1: ['EndOfShifting'] },
    { name: 'canalPassage', stage0: ['Begin canal passage'], stage1: ['End canal passage'] },
    { name: 'anchoringDrifting', stage0: ['Begin Anchoring/Drifting'], stage1: ['End Anchoring/Drifting'] },
    { name: 'fuelChangeOver', stage0: ['Begin fuel change over'], stage1: ['End fuel change over'] },
    { name: 'deviation', stage0: ['Begin of deviation'], stage1: ['End of deviation'] },
    { name: 'specialArea', stage0: ['Entering special area'], stage1: ['Leaving special area'] },
    { name: 'offhire', stage0: ['Beginofoffhire'], stage1: ['Endofoffhire'] },
  ];
}

// Ports ovl/pkg/validation/config.go's DefaultConfig — used for every
// schema other than log-abstract, which are otherwise untouched by
// plausibility/continuity rules beyond ordering/timestamp-uniqueness.
export function defaultConfig(): ValidationConfig {
  return {
    timeBucketToleranceHours: 0.1,
    impliedSpeedMinKn: 0,
    impliedSpeedMaxKn: 30,
    timeChainToleranceHours: 0.1,
    robToleranceMt: 0.5,
    robSeriesList: [],
    bunkeredAmounts: {},
    fuelTypeConsumptionFields: [],
    bdnMarkerFields: [],
    eventGroups: defaultEventGroups(),
    severities: {},
  };
}

// Ports ovl/pkg/validation/config.go's LogAbstractConfig + its
// logAbstractFuelTypes table — the only real curated config. BDN scheme
// is explicitly out of scope (bdnMarkerFields stays empty) and
// bunkeredAmounts is left empty (no bunkered-since-previous tracking
// exists in this port yet), matching the original's own current state.
const LOG_ABSTRACT_FUEL_TYPES: { suffix: string; robField: string; extraConsumers: boolean }[] = [
  { suffix: 'HFO', robField: 'HFO_ROB', extraConsumers: true },
  { suffix: 'LFO', robField: 'LFO_ROB', extraConsumers: true },
  { suffix: 'MGO', robField: 'MGO_ROB', extraConsumers: true },
  { suffix: 'MDO', robField: 'MDO_ROB', extraConsumers: true },
  { suffix: 'LPGP', robField: 'LPGP_ROB', extraConsumers: false },
  { suffix: 'LPGB', robField: 'LPGB_ROB', extraConsumers: false },
  { suffix: 'LNG', robField: 'LNG_ROB', extraConsumers: false },
  { suffix: 'M', robField: 'Methanol_ROB', extraConsumers: false },
  { suffix: 'E', robField: 'Ethanol_ROB', extraConsumers: false },
  { suffix: 'O', robField: 'O_ROB', extraConsumers: false },
];

export function logAbstractConfig(): ValidationConfig {
  const robSeriesList: RobSeries[] = [];
  const fuelTypeConsumptionFields: string[] = [];

  for (const { suffix, robField, extraConsumers } of LOG_ABSTRACT_FUEL_TYPES) {
    const consumptionFields = [
      `ME_Consumption_${suffix}`,
      `AE_Consumption_${suffix}`,
      `Boiler_Consumption_${suffix}`,
      ...(extraConsumers ? [`Inert_gas_Consumption_${suffix}`, `Cargo_heating_Consumption_${suffix}`] : []),
    ];
    robSeriesList.push({ name: suffix, robField, consumptionFields });
    fuelTypeConsumptionFields.push(...consumptionFields);
  }

  return {
    ...defaultConfig(),
    robSeriesList,
    fuelTypeConsumptionFields,
    bdnMarkerFields: [],
    bunkeredAmounts: {},
  };
}

// Ports ovl/vessel/httpapi/schemas.go's validationConfigFor. This port
// stores schemaName WITH a ".json" suffix on report rows (see
// getFieldPolicy's own comment in trpc.router.ts), unlike the original's
// bare name — compare against the same convention this port actually uses.
export function validationConfigFor(schemaName: string): ValidationConfig {
  return schemaName === 'log-abstract.json' ? logAbstractConfig() : defaultConfig();
}
