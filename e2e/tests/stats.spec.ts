import { expect, test } from '../fixtures';
import { StatsPage } from '../pages/StatsPage';

test('stats show how far each source got', async ({ page, api }) => {
  await api.createApplication({
    company: 'Acme',
    role: 'SDET',
    status: 'Applied',
    source: 'LinkedIn',
  });
  await api.createApplication({
    company: 'Globex',
    role: 'SDET',
    status: 'Applied',
    source: 'LinkedIn',
  });
  await api.createApplication({
    company: 'Initech',
    role: 'QA Lead',
    status: 'Interviewing',
    source: 'Referral',
  });
  const stats = new StatsPage(page);

  await stats.goto();

  // applications, applied, responded, interviewed, offers, response rate
  await expect(stats.figures('LinkedIn')).toHaveText(['2', '2', '0', '0', '0', '0%']);
  await expect(stats.figures('Referral')).toHaveText(['1', '1', '1', '1', '0', '100%']);
  await expect(stats.figures('All sources')).toHaveText(['3', '3', '1', '1', '0', '33%']);
});
