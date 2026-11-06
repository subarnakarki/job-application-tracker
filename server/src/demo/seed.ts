import { createHash } from 'node:crypto';
import { DATE_APPLIED_STATUSES, localDateIn, type Source, type Status } from '@jat/shared';
import { pathToFileURL } from 'node:url';
import { findOrCreateDemoUser } from '../auth/users';
import { saveAnalysis } from '../repo/resumes';
import { ANALYZER_MODEL } from '../resume/analyze';
import { SAMPLE_RESUME, sampleResult } from './sampleAnalysis';
import { createDb } from '../db/connection';
import type { Db } from '../db/types';

const DAY = 24 * 60 * 60 * 1000;

/** One sample application: where it came from and how it moved, in days before "now". */
interface Sample {
  company: string;
  role: string;
  source: Source;
  /** Each status it reached and how many days ago; the first is when it was added. */
  path: [Status, number][];
  salary?: [number, number];
  contact?: string;
  nextStep?: [string, number];
  notes?: string;
}

/**
 * The shared demo account's data: invented companies, a realistic SDET/QA search
 * a few weeks in. Two Applied ones are 7+ days quiet with no next step, so the
 * follow-up flag shows; every source appears, so the stats have something to say.
 */
export const DEMO_SAMPLES: readonly Sample[] = [
  {
    company: 'Quillstone Software',
    role: 'Senior SDET',
    source: 'Referral',
    path: [
      ['Applied', 24],
      ['Screening', 19],
      ['Interviewing', 12],
      ['Offer', 2],
    ],
    salary: [145000, 165000],
    contact: 'Dana Whitfield (Engineering Manager)',
    nextStep: ['Reply to the offer', 3],
    notes:
      'Referred by a former teammate. Offer includes a sign-on bonus; asked for the benefits summary.',
  },
  {
    company: 'Harborview Health',
    role: 'QA Automation Lead',
    source: 'LinkedIn',
    path: [
      ['Applied', 20],
      ['Screening', 15],
      ['Interviewing', 6],
    ],
    salary: [135000, 155000],
    contact: 'Priya Nair (Recruiter)',
    nextStep: ['Panel interview with the platform team', 2],
    notes:
      'Playwright + TypeScript stack, HIPAA-regulated releases. Prepare a test-strategy walkthrough.',
  },
  {
    company: 'Tidewater Fintech',
    role: 'Software Engineer in Test II',
    source: 'Company site',
    path: [
      ['Saved', 18],
      ['Applied', 16],
      ['Screening', 9],
      ['Interviewing', 4],
    ],
    salary: [125000, 140000],
    nextStep: ['Take-home review call', 1],
  },
  {
    company: 'Peakline Logistics',
    role: 'Test Automation Engineer',
    source: 'Indeed',
    path: [
      ['Applied', 14],
      ['Screening', 8],
    ],
    contact: 'Marcus Lee (Talent Partner)',
    nextStep: ['Hiring manager call', 5],
  },
  {
    company: 'Lumen Ridge Analytics',
    role: 'Senior QA Engineer',
    source: 'Recruiter',
    path: [
      ['Applied', 11],
      ['Screening', 5],
    ],
    salary: [120000, 135000],
    contact: 'Agency recruiter: Sam Ortiz',
    notes: 'Contract-to-hire. Recruiter screen went well; waiting for the client to schedule.',
  },
  {
    company: 'Kestrel Mobility',
    role: 'SDET, Mobile',
    source: 'LinkedIn',
    path: [['Applied', 13]],
    notes: 'Appium and Detox experience asked for.',
  },
  {
    company: 'Silverleaf Insurance',
    role: 'Quality Engineer',
    source: 'Indeed',
    path: [['Applied', 10]],
  },
  {
    company: 'Arcwell Systems',
    role: 'Staff Quality Engineer',
    source: 'Company site',
    path: [['Applied', 3]],
    salary: [160000, 185000],
  },
  {
    company: 'Fieldnote Labs',
    role: 'QA Engineer, Developer Tools',
    source: 'Referral',
    path: [['Applied', 2]],
    contact: 'Referral from Jordan (Fieldnote SRE)',
  },
  {
    company: 'Meridian Grid',
    role: 'Senior Test Engineer',
    source: 'LinkedIn',
    path: [
      ['Applied', 21],
      ['Rejected', 9],
    ],
    notes:
      'Rejected after the application review; they wanted embedded/hardware-in-the-loop testing.',
  },
  {
    company: 'Brambleworks',
    role: 'SDET',
    source: 'Recruiter',
    path: [
      ['Applied', 26],
      ['Screening', 20],
      ['Interviewing', 14],
      ['Rejected', 7],
    ],
    notes:
      'Made it to the final round. Feedback: strong on automation, wanted more load-testing depth.',
  },
  {
    company: 'Pinecrest Learning',
    role: 'QA Lead',
    source: 'Other',
    path: [
      ['Applied', 17],
      ['Withdrawn', 6],
    ],
    notes: 'Withdrew: fully on-site, two hours away.',
  },
  {
    company: 'Halcyon Games',
    role: 'Automation Engineer, Live Services',
    source: 'Company site',
    path: [['Saved', 4]],
    notes: 'Opening closes at the end of the month. Tailor the resume for game-backend testing.',
  },
  {
    company: 'Orchard & Pine',
    role: 'Senior SDET (Payments)',
    source: 'LinkedIn',
    path: [['Saved', 1]],
    salary: [140000, 160000],
  },
];

/**
 * Replaces everything in the demo account with the samples above, dated relative
 * to `now` so the data always looks current. One transaction: visitors see the
 * old data or the new, never half of each. Only the demo user is touched.
 */
export async function seedDemoData(db: Db, demoUserId: string, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const demo = await tx.query<{ is_demo: boolean }>('select is_demo from users where id = $1', [
      demoUserId,
    ]);
    if (demo.rows[0]?.is_demo !== true)
      throw new Error('Refusing to seed a user that is not the demo');

    await tx.query('delete from applications where user_id = $1', [demoUserId]);
    for (const sample of DEMO_SAMPLES) {
      const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
      const [first] = sample.path;
      const last = sample.path.at(-1);
      if (!first || !last) continue;
      const appliedStep = sample.path.find(([status]) =>
        (DATE_APPLIED_STATUSES as readonly Status[]).includes(status),
      );
      const inserted = await tx.query<{ id: string }>(
        `insert into applications (user_id, company, role, status, date_applied, source, salary_min,
           salary_max, salary_currency, contact, next_step, next_step_date, notes, created_at,
           updated_at, last_activity_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
         returning id`,
        [
          demoUserId,
          sample.company,
          sample.role,
          last[0],
          appliedStep ? localDateIn(at(appliedStep[1]), 'UTC') : null,
          sample.source,
          sample.salary?.[0] ?? null,
          sample.salary?.[1] ?? null,
          sample.salary ? 'USD' : null,
          sample.contact ?? null,
          sample.nextStep?.[0] ?? null,
          sample.nextStep
            ? localDateIn(new Date(now.getTime() + sample.nextStep[1] * DAY), 'UTC')
            : null,
          sample.notes ?? '',
          at(first[1]),
          at(last[1]),
        ],
      );
      const id = inserted.rows[0]?.id;
      let from: Status | null = null;
      for (const [status, daysAgo] of sample.path) {
        await tx.query(
          `insert into status_history (application_id, from_status, to_status, occurred_at, recorded_at, actor)
           values ($1, $2, $3, $4, $4, 'user')`,
          [id, from, status, at(daysAgo)],
        );
        from = status;
      }
    }
    // The resume match a visitor can look at (the demo account cannot upload a resume).
    await tx.query('delete from resume_analyses where user_id = $1', [demoUserId]);
    await saveAnalysis(
      tx,
      demoUserId,
      {
        fileName: 'Sample resume (Alex Rivera).pdf',
        textSha256: createHash('sha256').update(SAMPLE_RESUME).digest('hex'),
        result: sampleResult(),
        model: ANALYZER_MODEL,
      },
      now,
    );
    return DEMO_SAMPLES.length;
  });
}

/** `npm run demo:seed`: reset the demo account on the database in DATABASE_URL_DIRECT (or DATABASE_URL). */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_DIRECT'] ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('Set DATABASE_URL_DIRECT (or DATABASE_URL)');
  const db = createDb(url, { max: 1 });
  try {
    const demo = await findOrCreateDemoUser(db);
    const count = await seedDemoData(db, demo.id, new Date());
    console.log(`Seeded the demo account with ${count} applications`);
  } finally {
    await db.end();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
