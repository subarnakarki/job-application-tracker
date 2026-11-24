import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/types';
import { runMigrations } from '../db/migrate';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { dbUsageRecorder, MODEL_CALLS, usageEntry, type UsageEntry } from './record';

const ENTRY: UsageEntry = {
  call: 'draft',
  model: 'claude-haiku-5-5',
  inputTokens: 9000,
  cacheWriteTokens: 0,
  cacheReadTokens: 3000,
  outputTokens: 2500,
  webSearches: 0,
};

describe('usageEntry', () => {
  it('takes the counts from a response, missing ones as zero', () => {
    expect(
      usageEntry('job_search', {
        model: 'claude-haiku-5-5',
        usage: {
          input_tokens: 12000,
          output_tokens: 800,
          cache_creation_input_tokens: null,
          server_tool_use: { web_search_requests: 3 },
        },
      }),
    ).toEqual({
      call: 'job_search',
      model: 'claude-haiku-5-5',
      inputTokens: 12000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 800,
      webSearches: 3,
    });
  });
});

describe('dbUsageRecorder', () => {
  it('never rejects: a failed write is reported and dropped', async () => {
    const failing = {
      query: () => Promise.reject(new Error('down')),
    } as unknown as Db;
    const errors: unknown[] = [];
    await expect(
      dbUsageRecorder(failing, (error) => errors.push(error))(ENTRY),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    await expect(dbUsageRecorder(null)(ENTRY)).resolves.toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('model_usage (real Postgres)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('stores one row of counts per call, with no user or content', async () => {
    await dbUsageRecorder(testDb.db)(ENTRY);
    const { rows } = await testDb.db.query(
      `select call, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
          web_searches from model_usage`,
    );
    expect(rows).toEqual([
      {
        call: 'draft',
        model: 'claude-haiku-5-5',
        input_tokens: 9000,
        cache_write_tokens: 0,
        cache_read_tokens: 3000,
        output_tokens: 2500,
        web_searches: 0,
      },
    ]);
  });

  it('accepts every kind of call the code records, and refuses a malformed one', async () => {
    const errors: unknown[] = [];
    const record = dbUsageRecorder(testDb.db, (error) => errors.push(error));
    for (const call of MODEL_CALLS) await record({ ...ENTRY, call });
    expect(errors).toEqual([]);
    await record({ ...ENTRY, call: 'Not a kind!' as UsageEntry['call'] });
    expect(errors).toHaveLength(1);
  });
});
