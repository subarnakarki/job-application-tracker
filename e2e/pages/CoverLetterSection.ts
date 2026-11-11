import type { Locator, Page } from '@playwright/test';

/** The "Cover letter" section of an application page. */
export class CoverLetterSection {
  readonly root: Locator;
  readonly draftButton: Locator;
  readonly draftAgainButton: Locator;
  readonly steer: Locator;
  readonly posting: Locator;
  readonly draftFromPosting: Locator;
  readonly text: Locator;
  readonly count: Locator;
  readonly state: Locator;
  readonly saveButton: Locator;
  readonly copyButton: Locator;
  readonly undoButton: Locator;
  readonly removeButton: Locator;
  readonly printLink: Locator;
  readonly alert: Locator;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('region', { name: 'Cover letter', exact: true });
    this.draftButton = this.root.getByRole('button', { name: 'Draft cover letter' });
    this.draftAgainButton = this.root.getByRole('button', { name: 'Draft again' });
    this.steer = this.root.getByLabel('What to stress (optional)');
    this.posting = this.root.getByLabel('Paste the job posting');
    this.draftFromPosting = this.root.getByRole('button', { name: 'Draft from this posting' });
    this.text = this.root.getByLabel('Cover letter text');
    this.count = this.root.getByText(/ words? · \d+ of 5000 characters/);
    this.state = this.root
      .getByRole('status')
      .filter({ hasText: /^(Draft from|Saved on|Edited, not saved yet)/ });
    this.saveButton = this.root.getByRole('button', { name: 'Save', exact: true });
    this.copyButton = this.root.getByRole('button', { name: 'Copy', exact: true });
    this.undoButton = this.root.getByRole('button', { name: 'Undo edits' });
    this.removeButton = this.root.getByRole('button', { name: 'Remove', exact: true });
    this.printLink = this.root.getByRole('link', { name: 'Print or save as PDF' });
    this.alert = this.root.getByRole('alert');
    this.dialog = page.getByRole('dialog');
  }

  length(label: RegExp | string): Locator {
    return this.root.getByRole('group', { name: 'Length' }).getByRole('radio', { name: label });
  }

  tone(label: string): Locator {
    return this.root
      .getByRole('group', { name: 'Tone' })
      .getByRole('radio', { name: label, exact: true });
  }
}
