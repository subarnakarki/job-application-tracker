import type { Locator, Page } from '@playwright/test';

export class ResumePage {
  readonly heading: Locator;
  readonly fileInput: Locator;
  readonly analyse: Locator;
  readonly results: Locator;
  readonly titles: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Resume match', level: 1 });
    this.fileInput = page.getByLabel('Resume file');
    this.analyse = page.getByRole('button', { name: 'Find my best-fit titles' });
    this.results = page.getByRole('heading', { name: /^Your top \d+ titles$/ });
    // Each title is a list item holding a card (the keyword chips are list items too).
    this.titles = page
      .getByRole('list', { name: 'Best-fit titles' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('article') });
  }

  async goto() {
    await this.page.goto('/resume');
    await this.heading.waitFor();
  }

  /** A title's card, by its heading. */
  card(title: string): Locator {
    return this.page
      .getByRole('article')
      .filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
  }
}
