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

  /** The "Move to" status menu on an application's card (list or board). */
  moveMenu(company: string): Locator {
    return this.page.getByRole('combobox', { name: `Move ${company} to` });
  }

  view(name: 'List' | 'Board'): Locator {
    return this.page.getByRole('group', { name: 'View' }).getByRole('button', { name });
  }

  column(status: Status): Locator {
    return this.page
      .getByRole('region', { name: 'Board' })
      .getByRole('region', { name: new RegExp(`^${status}`) });
  }

  dragHandle(company: string): Locator {
    return this.page.getByRole('button', { name: `Drag ${company}` });
  }

  /** Drags a card onto another column with the mouse, in small steps as a person would. */
  async dragTo(company: string, status: Status) {
    const card = this.page
      .getByRole('region', { name: 'Board' })
      .getByRole('listitem')
      .filter({ hasText: company });
    const from = await card.boundingBox();
    const to = await this.column(status).boundingBox();
    if (!from || !to) throw new Error('card or column not visible');
    await this.page.mouse.move(from.x + 20, from.y + 20);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + 40, from.y + 40, { steps: 5 });
    await this.page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
    await this.page.mouse.up();
  }
}
