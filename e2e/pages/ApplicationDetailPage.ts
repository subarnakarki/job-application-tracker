import type { Locator, Page } from '@playwright/test';

export class ApplicationDetailPage {
  readonly editButton: Locator;
  readonly deleteButton: Locator;
  readonly history: Locator;
  readonly confirmDialog: Locator;

  constructor(private readonly page: Page) {
    this.editButton = page.getByRole('link', { name: 'Edit' });
    this.deleteButton = page.getByRole('button', { name: 'Delete' });
    this.history = page.getByRole('region', { name: 'Status history' }).getByRole('listitem');
    this.confirmDialog = page.getByRole('dialog');
  }

  heading(company: string): Locator {
    return this.page.getByRole('heading', { name: company, level: 1 });
  }

  async goto(id: string) {
    await this.page.goto(`/applications/${id}`);
  }
}
