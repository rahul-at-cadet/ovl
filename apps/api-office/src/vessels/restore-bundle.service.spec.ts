import { RestoreBundleService } from './restore-bundle.service';
import { decrypt, generateIdentity } from './logic/backup-crypto';

jest.setTimeout(30_000);

const VESSEL_ID = '01a01028-cc4d-78ba-9b44-fff044383b5f';

/**
 * A stand-in for drizzle's builder that answers each select in order,
 * from an explicit script. Only the read *shape* is exercised here; that
 * the queries themselves return the right rows is covered by driving the
 * real endpoints against Postgres.
 *
 * The timestamp strings the tests feed it are the point of this file:
 * they are exactly what Postgres hands back in drizzle's
 * `mode: 'string'`, which is not the RFC3339 the vessel's schema
 * promises.
 */
function makeDb(...results: any[][]) {
  let call = 0;
  const next = () => Promise.resolve(results[Math.min(call++, results.length - 1)] ?? []);
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => next(),
    orderBy: () => next(),
    then: (...args: any[]) => next().then(...args),
  };
  return { select: () => chain } as any;
}

const VESSEL_ROW = [{ id: VESSEL_ID, name: 'Dummy_1', imo: '9876543' }];

/** build() reads the vessel row, then versions, events and chat. */
const forBuild = (versions: any[], events: any[], chat: any[]) =>
  makeDb(VESSEL_ROW, versions, events, chat);

/** buildEncrypted() reads the enrollment's DR key before all of that. */
const forBuildEncrypted = (drPublicKey: string | null, versions: any[], events: any[], chat: any[]) =>
  makeDb([{ drPublicKey }], VESSEL_ROW, versions, events, chat);

const configBundleService = { resolveForVessel: async () => null } as any;

describe('RestoreBundleService.build', () => {
  const versionRow = {
    reportId: 'r-1',
    versionNo: 1,
    schemaKind: 'log-abstract.json',
    schemaVersion: '1.0',
    eventType: 'ReportSubmitted',
    state: 'submitted',
    // Postgres's own rendering: space separator, two-digit offset.
    eventTime: '2026-08-20 16:00:00+00',
    fields: { Latitude_Degree: 12 },
    submittedAt: '2026-08-20 14:38:33.46+00',
    receivedAt: '2026-08-20 14:38:34+00',
  };
  const eventRow = {
    reportId: 'r-1',
    versionNo: 1,
    eventType: 'submitted',
    actor: 'chief.officer',
    occurredAt: '2026-08-20 14:38:33.46+00',
    detail: {},
  };
  const chatRow = {
    id: 'c-1',
    reportId: 'r-1',
    sender: 'shore.reviewer',
    body: 'Confirm the bunker figure.',
    sentAt: '2026-08-20 06:43:22.089+00',
    direction: 'office',
  };

  it('renders every timestamp as RFC3339', async () => {
    // The vessel writes "2026-08-20T16:00:00.000Z" itself and its schema
    // documents these columns as RFC3339. Passing Postgres's form
    // through left a restored node holding two different formats, and
    // Safari's Date rejects the Postgres one outright — every restored
    // report would render "Invalid Date" on a crew laptop.
    const svc = new RestoreBundleService(
      forBuild([versionRow], [eventRow], [chatRow]),
      configBundleService,
    );
    const bundle = await svc.build(VESSEL_ID);
    const [report] = bundle.reports;

    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    expect(report.versions[0].eventTime).toMatch(rfc3339);
    expect(report.versions[0].submittedAt).toMatch(rfc3339);
    expect(report.versions[0].receivedAt).toMatch(rfc3339);
    expect(report.events[0].at).toMatch(rfc3339);
    expect(report.chat[0].sentAt).toMatch(rfc3339);

    // Normalised, not altered — the instant has to survive the reshaping.
    expect(report.versions[0].eventTime).toBe('2026-08-20T16:00:00.000Z');
    expect(new Date(report.events[0].at).getTime()).toBe(new Date(eventRow.occurredAt).getTime());
  });

  it('keeps a null submittedAt null rather than inventing a date', async () => {
    const svc = new RestoreBundleService(
      forBuild([{ ...versionRow, submittedAt: null }], [], []),
      configBundleService,
    );
    const bundle = await svc.build(VESSEL_ID);
    expect(bundle.reports[0].versions[0].submittedAt).toBeNull();
  });

  it('translates chat direction to the vessel-local convention', async () => {
    const svc = new RestoreBundleService(
      forBuild([versionRow], [], [chatRow, { ...chatRow, id: 'c-2', direction: 'vessel' }]),
      configBundleService,
    );
    const bundle = await svc.build(VESSEL_ID);
    expect(bundle.reports[0].chat.map((c) => c.direction)).toEqual(['shore_to_ship', 'ship_to_shore']);
  });

  it('keeps an event whose report has no versions on file', async () => {
    // Dropping it would quietly shorten the audit trail, which is the
    // one thing a restored vessel cannot reconstruct for itself.
    const svc = new RestoreBundleService(
      forBuild([], [{ ...eventRow, reportId: 'orphan' }], []),
      configBundleService,
    );
    const bundle = await svc.build(VESSEL_ID);
    expect(bundle.reports).toHaveLength(1);
    expect(bundle.reports[0]).toMatchObject({ reportId: 'orphan', versions: [] });
    expect(bundle.reports[0].events).toHaveLength(1);
  });

  it('refuses to encrypt for a vessel with no DR key', async () => {
    const svc = new RestoreBundleService(
      forBuildEncrypted(null, [], [], []),
      configBundleService,
    );
    await expect(svc.buildEncrypted(VESSEL_ID)).rejects.toThrow(/no restore key on file/);
  });
});

describe('a bundle round-trips through age', () => {
  it('encrypts to the vessel key and decrypts back to the same document', async () => {
    const identity = await generateIdentity();
    const svc = new RestoreBundleService(
      forBuildEncrypted(
        identity.publicKey,
        [
          {
            reportId: 'r-1',
            versionNo: 1,
            schemaKind: 'log-abstract.json',
            schemaVersion: '1.0',
            eventType: 'ReportSubmitted',
            state: 'submitted',
            eventTime: '2026-08-20 16:00:00+00',
            fields: {},
            submittedAt: null,
            receivedAt: '2026-08-20 14:38:34+00',
          },
        ],
        [],
        [],
      ),
      configBundleService,
    );
    const built = await svc.buildEncrypted(VESSEL_ID);
    const plaintext = await decrypt(Buffer.from(built.ciphertextBase64, 'base64'), identity.privateKey);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));

    expect(decoded.wireVersion).toBe(1);
    expect(decoded.reports[0].versions[0].eventTime).toBe('2026-08-20T16:00:00.000Z');
    expect(built.reportCount).toBe(1);
    expect(built.versionCount).toBe(1);
  });
});
