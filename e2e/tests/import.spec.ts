import { expect, test } from '../fixtures';
import { ImportResultsPage } from '../pages/ImportResultsPage';

test('import results: undo an added application, dismiss a suggestion', async ({
  page,
  api,
  applicationsPage,
}) => {
  const runId = await api.seedImport([
    {
      subject: 'Thanks for applying',
      from: 'jobs@initech.example',
      hoursAgo: 2,
      verdict: {
        kind: 'application_confirmation',
        company: 'Initech',
        role: 'QA Engineer',
        confidence: 'high',
        summary: 'Initech received the application.',
      },
    },
    {
      subject: 'An exciting opportunity',
      from: 'talent@hooli.example',
      hoursAgo: 1,
      verdict: {
        kind: 'offer',
        company: 'Hooli',
        role: null,
        confidence: 'low',
        summary: 'Possibly an offer from Hooli.',
      },
    },
  ]);
  const results = new ImportResultsPage(page);

  await results.goto(runId);
  const added = results.card(results.changes, 'Added Initech as Applied');
  await expect(added).toBeVisible();
  const suggestion = results.card(results.review, 'Hooli: suggest Offer');
  await expect(suggestion).toContainText('Not sure enough to change anything');

  await added.getByRole('button', { name: 'Undo' }).click();
  await expect(results.card(results.changes, 'Initech: undone')).toBeVisible();

  await suggestion.getByRole('button', { name: 'Dismiss' }).click();
  await expect(results.card(results.review, 'Hooli: dismissed')).toBeVisible();

  await applicationsPage.goto();
  await expect(applicationsPage.emptyState).toBeVisible();
});
