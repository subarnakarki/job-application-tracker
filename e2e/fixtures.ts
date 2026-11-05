import type { ApplicationDetail, ApplicationInput } from '@jat/shared';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { ApplicationDetailPage } from './pages/ApplicationDetailPage';
import { ApplicationFormPage } from './pages/ApplicationFormPage';
import { ApplicationsPage } from './pages/ApplicationsPage';

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
