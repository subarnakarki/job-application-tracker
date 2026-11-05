import type { Locator, Page } from '@playwright/test';

/** Tailwind's `sm` breakpoint: the table from here up, cards below. */
const SM = 640;

export class StatsPage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Stats by source', level: 1 });
  }

  async goto() {
    await this.page.goto('/stats');
    await this.heading.waitFor();
  }

  private get wide(): boolean {
    return (this.page.viewportSize()?.width ?? SM) >= SM;
  }

  /**
   * The figures for a source (or 'All sources') in reading order, whichever layout is shown:
   * applications, applied, responded, interviewed, offers, then the response rate.
   */
  figures(name: string): Locator {
    if (this.wide) {
      return this.page
        .getByRole('table', { name: 'Applications by source' })
        .getByRole('row', { name: new RegExp(`^${name}`) })
        .getByRole('cell');
    }
    return this.page
      .getByRole('list', { name: 'Applications by source' })
      .getByRole('listitem')
      .filter({ has: this.page.getByRole('heading', { name: new RegExp(`^${name}`) }) })
      .getByRole('definition');
  }
}
