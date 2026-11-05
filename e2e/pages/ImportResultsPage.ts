import type { Locator, Page } from '@playwright/test';

export class ImportResultsPage {
  readonly heading: Locator;
  readonly changes: Locator;
  readonly review: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Gmail import', level: 1 });
    this.changes = page.getByRole('list', { name: 'Changes made' }).getByRole('listitem');
    this.review = page.getByRole('list', { name: 'Needs your review' }).getByRole('listitem');
  }

  async goto(runId: string) {
    await this.page.goto(`/import/${runId}`);
    await this.heading.waitFor();
  }

  /** The card whose headline starts with `text`. */
  card(list: Locator, text: string): Locator {
    return list.filter({ has: this.page.getByRole('heading', { name: new RegExp(`^${text}`) }) });
  }
}
