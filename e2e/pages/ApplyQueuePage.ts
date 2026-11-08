import type { Locator, Page } from '@playwright/test';

/** The apply queue, read the way Claude in Chrome reads it: by headings, labels and roles. */
export class ApplyQueuePage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Apply queue', level: 1 });
  }

  async goto() {
    await this.page.goto('/apply-queue');
    await this.heading.waitFor();
  }

  /** Switches to a tab of the queue ("Ready to apply", "Needs you", ...). */
  async openTab(name: string) {
    await this.page
      .getByRole('navigation', { name: 'Queue sections' })
      .getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
      .click();
    await this.page.getByRole('heading', { name: new RegExp(`^${name} \\(`), level: 2 }).waitFor();
  }

  /** Unfolds a job's answers (folded away on its card at first). */
  async showAnswers(job: Locator) {
    await job.locator('summary', { hasText: 'Show answers' }).click();
  }

  /** A section of the queue ("Ready to apply", "Needs you", ...), by its heading. */
  section(name: RegExp): Locator {
    return this.page.locator('section').filter({
      has: this.page.getByRole('heading', { name, level: 2 }),
    });
  }

  /** One job's card, by "Company: Role". */
  job(title: string): Locator {
    return this.page
      .getByRole('article')
      .filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
  }

  /** The answer listed for a question (or a field such as "Email") on a job's card. */
  answer(job: Locator, question: string): Locator {
    return job
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }
}
