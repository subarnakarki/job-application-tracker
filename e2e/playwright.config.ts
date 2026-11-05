import { defineConfig, devices } from '@playwright/test';

/**
 * Runs the real app: the Fastify API (with the test-only routes switched on, against its own
 * database) behind the Vite dev server, so the browser sees one origin, as in production.
 *
 * E2E_DATABASE_URL must point at a migrated database the tests may write to.
 */
const databaseUrl = process.env['E2E_DATABASE_URL'];
if (!databaseUrl)
  throw new Error('E2E_DATABASE_URL is required (a migrated database for e2e runs)');

export const TEST_ROUTES_SECRET =
  process.env['TEST_ROUTES_SECRET'] ?? 'e2e-only-secret-not-for-production';
const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    extraHTTPHeaders: { 'x-test-secret': TEST_ROUTES_SECRET },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !ci,
      env: {
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
        ENABLE_TEST_ROUTES: '1',
        TEST_ROUTES_SECRET,
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      cwd: '../web',
      url: 'http://localhost:5173',
      reuseExistingServer: !ci,
    },
  ],
});
