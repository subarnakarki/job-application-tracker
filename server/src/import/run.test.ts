import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import {
  createApplication,
  getApplication,
  updateApplication,
  type Owner,
} from '../repo/applications';
import {
  finishRun,
  getRun,
  IMPORT_STALE_AFTER_MS,
  startRun,
  type ImportItem,
} from '../repo/imports';
import { mutableClock, T0 } from '../test/app';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { applyItem, dismissItem, undoItem } from './actions';
import { ClassifierUnavailableError, type Classification, type EmailClassifier } from './classify';
import { GmailError, type GmailClient, type GmailMessage } from './gmail';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { suggestionsOf } from '../repo/postingSuggestions';
import { ImportAlreadyRunningError, runImport, type ImportDeps } from './run';
import type { EmailVerdict } from './verdict';

const HOUR = 60 * 60 * 1000;

const fixture = (name: string) =>
  readFileSync(new URL(`../postings/fixtures/${name}`, import.meta.url), 'utf8');

/** The internet, as far as these tests go: the given URLs, and 404 for everything else. */
function internet(map: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    const text = map[url];
    return text === undefined
      ? Promise.reject(new FetchError('http_status', '404'))
      : Promise.resolve({ url, contentType: 'application/json', text });
  };
  return Object.assign(fetcher, { asked });
}

const FIGMA_JOB = JSON.parse(fixture('greenhouse-job-pay.json')) as { id: number };
const FIGMA_LINK = `https://job-boards.greenhouse.io/figma/jobs/${FIGMA_JOB.id}`;
const FIGMA_API = `https://boards-api.greenhouse.io/v1/boards/figma/jobs/${FIGMA_JOB.id}?pay_transparency=true`;

function email(id: string, hoursAgo: number): GmailMessage {
  return {
    id,
    from: `${id}@example.com`,
    subject: `Subject ${id}`,
    date: new Date(T0.getTime() - hoursAgo * HOUR),
    body: 'body',
  };
}

function verdict(overrides: Partial<EmailVerdict>): Classification {
  return {
    kind: 'verdict',
    verdict: {
      postingUrl: null,
      kind: 'rejection',
      company: 'Acme',
      role: 'SDET',
      confidence: 'high',
      summary: 'A summary.',
      ...overrides,
    },
  };
}

/** A fake inbox: what Gmail lists and returns, and what the classifier says about each email. */
class Inbox implements GmailClient, EmailClassifier {
  messages = new Map<string, GmailMessage>();
  verdicts = new Map<string, Classification | Error>();
  unreadable = new Set<string>();
  queries: string[] = [];

  add(message: GmailMessage, classification: Classification | Error) {
    this.messages.set(message.id, message);
    this.verdicts.set(message.id, classification);
    return this;
  }
  listMessageIds(_token: string, query: string) {
    this.queries.push(query);
    return Promise.resolve([...this.messages.keys()]);
  }
  getMessage(_token: string, id: string) {
    const message = this.messages.get(id);
    if (!message || this.unreadable.has(id)) return Promise.reject(new GmailError('404'));
    return Promise.resolve(message);
  }
  classify(message: GmailMessage): Promise<Classification> {
    const answer = this.verdicts.get(message.id);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? { kind: 'unclassified', reason: 'none' });
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Gmail import (real Postgres, fake Gmail and Claude)', () => {
  let testDb: TestDb;
  let owner: Owner;
  let inbox: Inbox;
  let deps: ImportDeps;
  const clock = mutableClock();

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    const user = await insertUser(testDb.db);
    owner = { userId: user.id, isDemo: false, timeZone: 'UTC' };
    inbox = new Inbox();
    deps = { db: testDb.db, gmail: inbox, classifier: inbox, clock };
  });

  async function track(company: string, status: 'Saved' | 'Applied' | 'Interviewing') {
    const created = await createApplication(
      testDb.db,
      owner,
      {
        company,
        role: 'SDET',
        status,
        dateApplied: null,
        source: 'LinkedIn',
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        jobLink: null,
        contact: null,
        nextStep: null,
        nextStepDate: null,
        location: null,
        workMode: null,
        postedOn: null,
        notes: '',
        leadId: null,
      },
      clock.now(),
    );
    if (created.kind !== 'created') throw new Error('not created');
    return created.value.record;
  }

  async function itemsOf(runId: string): Promise<Map<string, ImportItem>> {
    const run = await getRun(testDb.db, owner.userId, runId);
    return new Map((run?.items ?? []).map((item) => [item.gmailMessageId, item]));
  }

  it('creates, changes, reviews and ignores, and marks its changes as made by Gmail', async () => {
    const globex = await track('Globex', 'Applied');
    inbox
      .add(email('new', 5), verdict({ kind: 'application_confirmation', company: 'Initech' }))
      .add(email('rejected', 4), verdict({ kind: 'rejection', company: 'Globex, Inc.' }))
      .add(email('unsure', 3), verdict({ kind: 'offer', company: 'Globex', confidence: 'low' }))
      .add(email('alert', 2), verdict({ kind: 'not_job_related', company: '' }))
      .add(email('refused', 1), { kind: 'unclassified', reason: 'Declined' });

    const runId = await runImport(deps, owner, 'token');
    const items = await itemsOf(runId);

    expect(items.get('new')).toMatchObject({ outcome: 'created', toStatus: 'Applied' });
    expect(items.get('rejected')).toMatchObject({
      outcome: 'status_changed',
      applicationId: globex.id,
      fromStatus: 'Applied',
      toStatus: 'Rejected',
    });
    expect(items.get('unsure')).toMatchObject({ outcome: 'needs_review', proposedStatus: 'Offer' });
    expect(items.get('alert')).toMatchObject({ outcome: 'ignored' });
    expect(items.get('refused')).toMatchObject({ outcome: 'needs_review', reason: 'Declined' });
    expect(items.get('new')).toMatchObject({
      emailSubject: 'Subject new',
      emailFrom: 'new@example.com',
    });

    const changed = await getApplication(testDb.db, owner.userId, globex.id);
    expect(changed?.record.status).toBe('Rejected');
    expect(changed?.history.at(-1)?.actor).toBe('gmail');
    const created = items.get('new')?.applicationId;
    const createdApp = await getApplication(testDb.db, owner.userId, created ?? '');
    expect(createdApp?.record).toMatchObject({ company: 'Initech', role: 'SDET', source: 'Other' });
    expect(createdApp?.history[0]?.actor).toBe('gmail');
  });

  describe('date applied', () => {
    /** 03:00 UTC on 20 Oct is still the evening of 19 Oct in New York. */
    const onOct20Utc = (id: string): GmailMessage => ({
      ...email(id, 0),
      date: new Date('2026-10-20T03:00:00Z'),
    });

    it("is the email's day in the user's time zone, not the day of the import", async () => {
      owner = { ...owner, timeZone: 'America/New_York' };
      const saved = await track('Saved Co', 'Saved');
      inbox
        .add(onOct20Utc('new'), verdict({ kind: 'application_confirmation', company: 'New Co' }))
        .add(
          onOct20Utc('saved'),
          verdict({ kind: 'application_confirmation', company: 'Saved Co' }),
        );

      const items = await itemsOf(await runImport(deps, owner, 'token'));
      const created = await getApplication(
        testDb.db,
        owner.userId,
        items.get('new')?.applicationId ?? '',
      );
      const moved = await getApplication(testDb.db, owner.userId, saved.id);

      expect(created?.record.dateApplied).toBe('2026-10-19');
      expect(moved?.record.dateApplied).toBe('2026-10-19');
    });

    it('never replaces a date that is already there', async () => {
      const app = await track('Dated', 'Applied'); // auto-filled with the day it was tracked
      const before = app.dateApplied;
      inbox.add(onOct20Utc('no'), verdict({ kind: 'rejection', company: 'Dated' }));

      await runImport(deps, owner, 'token');

      expect((await getApplication(testDb.db, owner.userId, app.id))?.record.dateApplied).toBe(
        before,
      );
    });

    it("uses the email's day when a review item is applied", async () => {
      inbox.add(
        onOct20Utc('maybe'),
        verdict({ kind: 'application_confirmation', company: 'Maybe Co', confidence: 'low' }),
      );
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('maybe');

      const applied = await applyItem(testDb.db, owner, item?.id ?? '', clock.now());
      const app = await getApplication(
        testDb.db,
        owner.userId,
        applied.kind === 'done' ? (applied.item.applicationId ?? '') : '',
      );

      expect(app?.record.dateApplied).toBe('2026-10-20');
    });
  });

  it('applies emails oldest first: a confirmation, then that company rejecting', async () => {
    inbox
      .add(email('no', 1), verdict({ kind: 'rejection', company: 'Hooli' }))
      .add(email('thanks', 30), verdict({ kind: 'application_confirmation', company: 'Hooli' }));

    const items = await itemsOf(await runImport(deps, owner, 'token'));

    expect(items.get('thanks')?.outcome).toBe('created');
    expect(items.get('no')).toMatchObject({ outcome: 'status_changed', toStatus: 'Rejected' });
  });

  it('never handles an email twice, and only looks at newer mail next time', async () => {
    inbox.add(email('once', 1), verdict({ kind: 'application_confirmation', company: 'Once' }));
    await runImport(deps, owner, 'token');
    clock.advance(HOUR);

    const second = await getRun(testDb.db, owner.userId, await runImport(deps, owner, 'token'));

    expect(second?.items).toEqual([]);
    expect(inbox.queries[0]).toMatch(/^newer_than:30d/);
    expect(inbox.queries[1]).toMatch(/^after:\d+/);
  });

  describe('one import at a time', () => {
    it('refuses a second import while one is running, and allows it once that one is done', async () => {
      const first = await startRun(testDb.db, owner.userId, clock.now());
      expect(first).toBeTruthy();
      inbox.add(email('waits', 1), verdict({ kind: 'application_confirmation', company: 'Waits' }));

      await expect(runImport(deps, owner, 'token')).rejects.toBeInstanceOf(
        ImportAlreadyRunningError,
      );
      expect(inbox.queries).toEqual([]); // refused before it asked Gmail for anything

      await finishRun(testDb.db, owner.userId, first ?? '', {
        status: 'finished',
        emailsScanned: 0,
        now: clock.now(),
      });
      const items = await itemsOf(await runImport(deps, owner, 'token'));
      expect(items.get('waits')?.outcome).toBe('created');
    });

    it('lets exactly one of several simultaneous starts through', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => startRun(testDb.db, owner.userId, clock.now())),
      );

      expect(results.filter((id) => id !== null)).toHaveLength(1);
    });

    it('does not make other users wait', async () => {
      await startRun(testDb.db, owner.userId, clock.now());
      const other = await insertUser(testDb.db);

      expect(await startRun(testDb.db, other.id, clock.now())).toBeTruthy();
    });

    it('takes a run left running for ages as dead, and marks it failed', async () => {
      const stuck = (await startRun(testDb.db, owner.userId, clock.now())) ?? '';
      clock.advance(IMPORT_STALE_AFTER_MS - 1000);
      expect(await startRun(testDb.db, owner.userId, clock.now())).toBeNull();

      clock.advance(2000);
      expect(await startRun(testDb.db, owner.userId, clock.now())).toBeTruthy();
      expect((await getRun(testDb.db, owner.userId, stuck))?.run.status).toBe('failed');
    });

    it('frees the slot when a run fails', async () => {
      inbox.add(email('bad', 1), new ClassifierUnavailableError('bad key'));
      await expect(runImport(deps, owner, 'token')).rejects.toBeInstanceOf(
        ClassifierUnavailableError,
      );

      expect(await startRun(testDb.db, owner.userId, clock.now())).toBeTruthy();
    });
  });

  describe('job details from the posting', () => {
    const withLinks = (id: string, links: string[]) => ({
      ...email(id, 1),
      links: links.map((url) => ({ url, text: 'View the job' })),
    });
    const confirmation = (company: string, postingUrl: string | null, role: string | null = null) =>
      verdict({ kind: 'application_confirmation', company, role, postingUrl });

    it('fills a new application from the posting its email links to, and says so', async () => {
      const web = internet({ [FIGMA_API]: fixture('greenhouse-job-pay.json') });
      deps.postings = { fetchPage: web, fetchBoard: web };
      inbox.add(withLinks('figma', [FIGMA_LINK]), confirmation('Figma', FIGMA_LINK));

      const items = await itemsOf(await runImport(deps, owner, 'token'));
      const item = items.get('figma');
      expect(item?.reason).toBe(
        'New application; filled from the posting: role, salary, location, posting date',
      );
      const app = await getApplication(testDb.db, owner.userId, item?.applicationId ?? '');
      expect(app?.record).toMatchObject({
        company: 'Figma',
        role: 'Account Executive, Enterprise',
        jobLink: FIGMA_LINK,
        salaryMin: 165000,
        salaryMax: 190000,
        salaryCurrency: 'USD',
      });
    });

    it('ignores a link the email does not contain, so a made-up one is never read', async () => {
      const web = internet({ [FIGMA_API]: fixture('greenhouse-job-pay.json') });
      deps.postings = { fetchPage: web, fetchBoard: internet({}) };
      inbox.add(withLinks('other', []), confirmation('Figma', FIGMA_LINK, 'SDET'));

      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('other');
      const app = await getApplication(testDb.db, owner.userId, item?.applicationId ?? '');
      expect(app?.record.jobLink).toBeNull();
      expect(web.asked).toEqual([]);
    });

    it('keeps a link to an unknown site as the job link, without reading it', async () => {
      const link = 'https://careers.somewhere.example/jobs/1';
      const web = internet({});
      deps.postings = { fetchPage: web, fetchBoard: internet({}) };
      inbox.add(withLinks('site', [link]), confirmation('Somewhere', link, 'SDET'));

      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('site');
      const app = await getApplication(testDb.db, owner.userId, item?.applicationId ?? '');
      expect(app?.record.jobLink).toBe(link);
      expect(web.asked).toEqual([]);
    });

    it('with no link, finds the posting on the company’s job board and saves it as a suggestion', async () => {
      const stripe = internet({
        'https://boards-api.greenhouse.io/v1/boards/stripe/jobs': fixture('greenhouse-board.json'),
      });
      deps.postings = { fetchPage: internet({}), fetchBoard: stripe };
      inbox.add(email('stripe', 1), confirmation('Stripe', null, 'Abuse Investigator'));

      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('stripe');
      expect(item?.reason).toBe('New application; a possible posting was found on Greenhouse');
      const app = await getApplication(testDb.db, owner.userId, item?.applicationId ?? '');
      // Never applied by itself: the application is as the email left it.
      expect(app?.record).toMatchObject({
        role: 'Abuse Investigator',
        jobLink: null,
        location: null,
      });
      expect(app?.suggestion).toMatchObject({
        source: 'greenhouse',
        jobLink: 'https://stripe.com/jobs/search?gh_jid=8172487',
      });
    });

    it('never fails the import when postings or boards cannot be read', async () => {
      const broken: PageFetcher = () => Promise.reject(new Error('network down'));
      deps.postings = { fetchPage: broken, fetchBoard: broken };
      inbox.add(withLinks('a', [FIGMA_LINK]), confirmation('Figma', FIGMA_LINK, 'SDET'));
      inbox.add(email('b', 2), confirmation('Stripe', null, 'Abuse Investigator'));

      const items = await itemsOf(await runImport(deps, owner, 'token'));
      expect([...items.values()].map((item) => item.outcome)).toEqual(['created', 'created']);
      const ids = [...items.values()].map((item) => item.applicationId ?? '');
      expect([...(await suggestionsOf(testDb.db, ids)).values()]).toEqual([null, null]);
    });

    it('undoing a created application removes its suggestion with it', async () => {
      const stripe = internet({
        'https://boards-api.greenhouse.io/v1/boards/stripe/jobs': fixture('greenhouse-board.json'),
      });
      deps.postings = { fetchPage: internet({}), fetchBoard: stripe };
      inbox.add(email('undo', 1), confirmation('Stripe', null, 'Abuse Investigator'));
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('undo');

      expect((await undoItem(testDb.db, owner, item?.id ?? '', clock.now())).kind).toBe('done');
      expect(
        (await suggestionsOf(testDb.db, [item?.applicationId ?? ''])).get(
          item?.applicationId ?? '',
        ),
      ).toBeNull();
    });
  });

  it('sends an unreadable email to review instead of failing the run', async () => {
    inbox.add(email('broken', 1), verdict({}));
    inbox.unreadable.add('broken');

    const items = await itemsOf(await runImport(deps, owner, 'token'));

    expect(items.get('broken')).toMatchObject({
      outcome: 'needs_review',
      reason: 'Could not read the email',
    });
  });

  it('stops on a rejected API key, records the failure, and leaves the emails for next time', async () => {
    inbox.add(email('later', 1), new ClassifierUnavailableError('bad key'));

    await expect(runImport(deps, owner, 'token')).rejects.toBeInstanceOf(
      ClassifierUnavailableError,
    );
    inbox.verdicts.set('later', verdict({ kind: 'application_confirmation', company: 'Later' }));
    const items = await itemsOf(await runImport(deps, owner, 'token'));

    expect(items.get('later')?.outcome).toBe('created');
  });

  describe('undo, apply and dismiss', () => {
    it('undoes a created application by deleting it', async () => {
      inbox.add(email('new', 1), verdict({ kind: 'application_confirmation', company: 'Undo Co' }));
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('new');

      const result = await undoItem(testDb.db, owner, item?.id ?? '', clock.now());

      expect(result).toMatchObject({ kind: 'done', item: { outcome: 'undone' } });
      expect(await getApplication(testDb.db, owner.userId, item?.applicationId ?? '')).toBeNull();
    });

    it('undoes a status change back to the old status and date, as the user', async () => {
      const saved = await track('Savers', 'Saved');
      inbox.add(
        email('applied', 1),
        verdict({ kind: 'application_confirmation', company: 'Savers' }),
      );
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('applied');
      expect(
        (await getApplication(testDb.db, owner.userId, saved.id))?.record.dateApplied,
      ).not.toBeNull();

      await undoItem(testDb.db, owner, item?.id ?? '', clock.now());
      const app = await getApplication(testDb.db, owner.userId, saved.id);

      expect(app?.record).toMatchObject({ status: 'Saved', dateApplied: null });
      expect(app?.history.at(-1)).toMatchObject({ toStatus: 'Saved', actor: 'user' });
    });

    it('refuses to undo after the application was edited, and allows only one undo', async () => {
      const app = await track('Edited', 'Applied');
      inbox.add(email('no', 1), verdict({ kind: 'rejection', company: 'Edited' }));
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('no');
      const current = await getApplication(testDb.db, owner.userId, app.id);
      await updateApplication(
        testDb.db,
        owner,
        app.id,
        current?.record.version ?? 0,
        { notes: 'my note' },
        clock.now(),
      );

      expect(await undoItem(testDb.db, owner, item?.id ?? '', clock.now())).toMatchObject({
        kind: 'conflict',
      });
      const run = await getRun(testDb.db, owner.userId, item?.runId ?? '');
      expect(run?.items[0]?.outcome).toBe('status_changed');
    });

    it('allows only one undo of the same item', async () => {
      inbox.add(email('new', 1), verdict({ kind: 'application_confirmation', company: 'Twice' }));
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('new');

      const [first, second] = await Promise.all([
        undoItem(testDb.db, owner, item?.id ?? '', clock.now()),
        undoItem(testDb.db, owner, item?.id ?? '', clock.now()),
      ]);

      expect([first.kind, second.kind].sort()).toEqual(['conflict', 'done']);
    });

    it('applies a review item to its matched application, and can then undo it', async () => {
      const app = await track('Maybe', 'Interviewing');
      inbox.add(
        email('offer', 1),
        verdict({ kind: 'offer', company: 'Maybe', confidence: 'medium' }),
      );
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('offer');

      const applied = await applyItem(testDb.db, owner, item?.id ?? '', clock.now());
      expect(applied).toMatchObject({
        kind: 'done',
        item: { outcome: 'status_changed', toStatus: 'Offer' },
      });
      expect((await getApplication(testDb.db, owner.userId, app.id))?.record.status).toBe('Offer');

      await undoItem(testDb.db, owner, item?.id ?? '', clock.now());
      expect((await getApplication(testDb.db, owner.userId, app.id))?.record.status).toBe(
        'Interviewing',
      );
    });

    it('creates an application when a review item has no match, and dismisses others', async () => {
      inbox
        .add(email('untracked', 2), verdict({ kind: 'rejection', company: 'Nowhere' }))
        .add(
          email('other', 1),
          verdict({ kind: 'offer', company: 'Elsewhere', confidence: 'low' }),
        );
      const items = await itemsOf(await runImport(deps, owner, 'token'));

      const created = await applyItem(
        testDb.db,
        owner,
        items.get('untracked')?.id ?? '',
        clock.now(),
      );
      const dismissed = await dismissItem(testDb.db, owner, items.get('other')?.id ?? '');

      expect(created).toMatchObject({
        kind: 'done',
        item: { outcome: 'created', toStatus: 'Rejected' },
      });
      expect(dismissed).toMatchObject({ kind: 'done', item: { outcome: 'dismissed' } });
    });

    it("cannot touch another user's items", async () => {
      inbox.add(email('mine', 1), verdict({ kind: 'application_confirmation', company: 'Mine' }));
      const item = (await itemsOf(await runImport(deps, owner, 'token'))).get('mine');
      const stranger = await insertUser(testDb.db);
      const other: Owner = { userId: stranger.id, isDemo: false, timeZone: 'UTC' };

      expect(await undoItem(testDb.db, other, item?.id ?? '', clock.now())).toEqual({
        kind: 'not_found',
      });
    });
  });
});
