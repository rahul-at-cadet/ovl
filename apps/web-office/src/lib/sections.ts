// Ports ovl/web/office/src/screens/reports/sections.ts — human-readable
// section grouping for the report detail screen's field grid, which
// previously rendered every field as one flat, undifferentiated list
// (18.07.26 manual-test item 11 in the original: "a section with 40+
// fields read as one undifferentiated grid").

export interface SchemaFieldLike {
  name: string;
  label: string;
  section: string;
}

export function sectionsInOrder(fields: SchemaFieldLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    if (!seen.has(f.section)) {
      seen.add(f.section);
      out.push(f.section);
    }
  }
  return out;
}

// Verbatim copy of web/vessel's own section-label map (kept in sync by
// hand, same vendored-duplicate precedent as the rest of this port's
// office/vessel-shared display logic).
const SECTION_LABELS: Record<string, string> = {
  header: 'Basic',
  voyage: 'Voyage',
  position: 'Position',
  times: 'Times',
  distanceAndSpeed: 'Distance & Speed',
  cargo: 'Cargo',
  weather: 'Weather',
  'engine.consumption': 'Engine Consumption',
  'engine.performance': 'Engine Performance',
  rob: 'ROB',
  emissionsExtras: 'Emissions & Extras',
  remarks: 'Remarks',
  details: 'Details',
  fuelProperties: 'Fuel Properties',
  attachments: 'Attachments',
};

export function sectionLabel(key: string): string {
  if (SECTION_LABELS[key]) return SECTION_LABELS[key];
  return key
    .replace(/\./g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
