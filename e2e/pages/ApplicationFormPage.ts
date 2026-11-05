import type { Status } from '@jat/shared';
import type { Locator, Page } from '@playwright/test';

export class ApplicationFormPage {
  readonly company: Locator;
  readonly role: Locator;
  readonly status: Locator;
  readonly save: Locator;

  constructor(page: Page) {
    this.company = page.getByLabel('Company');
    this.role = page.getByLabel('Role');
    this.status = page.getByLabel('Status', { exact: true });
    this.save = page.getByRole('button', { name: /^Save/ });
  }

  async fill({ company, role, status }: { company?: string; role?: string; status?: Status }) {
    if (company !== undefined) await this.company.fill(company);
    if (role !== undefined) await this.role.fill(role);
    if (status !== undefined) await this.status.selectOption(status);
  }
}
