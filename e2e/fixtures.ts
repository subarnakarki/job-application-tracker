import type { ApplicationDetail, ApplicationInput, JobSearchProfile } from '@jat/shared';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { ApplicationDetailPage } from './pages/ApplicationDetailPage';
import { ApplicationFormPage } from './pages/ApplicationFormPage';
import { ApplicationsPage } from './pages/ApplicationsPage';

export interface SeedEmail {
  subject: string;
  from: string;
  hoursAgo: number;
  /** What Claude would say about it; null = it could not be classified. */
  verdict: {
    kind:
      | 'application_confirmation'
      | 'rejection'
      | 'interview_invite'
      | 'assessment'
      | 'offer'
      | 'not_job_related';
    company: string;
    role: string | null;
    confidence: 'high' | 'medium' | 'low';
    summary: string;
  } | null;
}

/** Test data goes in through the API, never through the UI. */
export class Api {
  constructor(private readonly request: APIRequestContext) {}

  async createApplication(
    input: Partial<ApplicationInput> & Pick<ApplicationInput, 'company' | 'role'>,
  ) {
    const response = await this.request.post('/api/applications', { data: input });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as ApplicationDetail;
  }

  /**
   * Saves the job search setup and runs a real search (test-only route) that "finds" the given
   * postings; `answers` is what the model drafts for each question, the rest need the candidate.
   */
  async seedJobSearch(seed: {
    profile: JobSearchProfile;
    jobs: {
      board: string;
      company: string;
      title: string;
      location: string;
      hoursAgo: number;
      content: string;
      questions: { label: string; required: boolean; options: string[] }[];
      /** The posting keywords its draft returns (for the fit score). */
      keywords?: string[];
    }[];
    answers: Record<string, string>;
  }) {
    const response = await this.request.post('/api/test/job-search', { data: seed });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { runId: string }).runId;
  }

  /** Stores pasted resume text for the signed-in user. */
  async uploadResumeText(text: string) {
    const response = await this.request.put('/api/resume', { data: { kind: 'text', text } });
    expect(response.status(), await response.text()).toBe(200);
  }

  async getApplication(id: string) {
    const response = await this.request.get(`/api/applications/${id}`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as ApplicationDetail;
  }

  /** An edit made somewhere else (another tab or device), as the same user. */
  async updateApplication(id: string, version: number, patch: Partial<ApplicationInput>) {
    const response = await this.request.patch(`/api/applications/${id}`, {
      data: patch,
      headers: { 'if-match': `"${version}"` },
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as ApplicationDetail;
  }

  /** Runs a real Gmail import from a fake inbox (test-only route); returns the run id. */
  async seedImport(emails: SeedEmail[]) {
    const response = await this.request.post('/api/test/import', { data: { emails } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { runId: string }).runId;
  }

  /** Moves this test user's clock forward (test-only route); nobody else's time changes. */
  async shiftClock(days: number) {
    const response = await this.request.post('/api/test/clock', {
      data: { offsetMs: days * 24 * 60 * 60 * 1000 },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

interface Fixtures {
  /** Every test starts as a brand-new user, signed in, with an empty private account. */
  signedIn: void;
  api: Api;
  applicationsPage: ApplicationsPage;
  formPage: ApplicationFormPage;
  detailPage: ApplicationDetailPage;
}

export const test = base.extend<Fixtures>({
  signedIn: [
    async ({ page }, use) => {
      // page.request shares the browser context's cookies, so this signs the page in too.
      const response = await page.request.post('/api/test/login', { data: {} });
      expect(response.ok(), await response.text()).toBe(true);
      await use();
    },
    { auto: true },
  ],
  api: async ({ page }, use) => use(new Api(page.request)),
  applicationsPage: async ({ page }, use) => use(new ApplicationsPage(page)),
  formPage: async ({ page }, use) => use(new ApplicationFormPage(page)),
  detailPage: async ({ page }, use) => use(new ApplicationDetailPage(page)),
});

export { expect };
