import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index';

describe('shared package', () => {
  it('exposes the app name', () => {
    expect(APP_NAME).toBe('Job Application Tracker');
  });
});
