import type { Status } from '@jat/shared';
import type { Locator, Page } from '@playwright/test';

export class ApplicationsPage {
  readonly heading: Locator;
  readonly addButton: Locator;
  readonly search: Locator;
  readonly followUpFilter: Locator;
  readonly cards: Locator;
  readonly emptyState: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Applications', level: 1 });
    this.addButton = page.getByRole('link', { name: 'Add application' });
    this.search = page.getByRole('searchbox', { name: 'Search' });
    this.followUpFilter = page.getByRole('button', { name: /Needs follow-up/ });
    this.cards = page.getByRole('list').last().getByRole('listitem');
    this.emptyState = page.getByText('No applications here yet.');
  }

  async goto() {
    await this.page.goto('/');
    await this.heading.waitFor();
  }

  stage(status: Status): Locator {
    return this.page
      .getByRole('group', { name: 'Pipeline stages' })
      .getByRole('button', { name: new RegExp(`^${status}`) });
  }

  card(company: string): Locator {
    return this.cards.filter({ hasText: company });
  }
}
