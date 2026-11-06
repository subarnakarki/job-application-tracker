import type { ApplicationDetail } from '@jat/shared';
import { EMPTY_FORM, fillEmpty, toFormValues, toPatch, validate, type FormValues } from './form';

function valid(values: FormValues) {
  const result = validate(values);
  if (!('input' in result))
    throw new Error(`expected valid input: ${JSON.stringify(result.errors)}`);
  return result.input;
}

describe('application form', () => {
  it('turns empty inputs into nulls and only sends a currency with a salary', () => {
    const input = valid({ ...EMPTY_FORM, company: 'Acme', role: 'SDET' });
    expect([input.dateApplied, input.salaryMin, input.salaryCurrency, input.jobLink]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const withSalary = valid({
      ...EMPTY_FORM,
      company: 'Acme',
      role: 'SDET',
      salaryMin: '90000',
      salaryCurrency: 'eur',
    });
    expect([withSalary.salaryMin, withSalary.salaryCurrency]).toEqual([90000, 'EUR']);
  });

  it('reports field errors from the shared schema', () => {
    const result = validate({ ...EMPTY_FORM, salaryMin: 'lots' });
    if (!('errors' in result)) throw new Error('expected errors');
    expect(Object.keys(result.errors)).toEqual(
      expect.arrayContaining(['company', 'role', 'salaryMin']),
    );
    expect(result.errors.salaryMin).toBe('Must be a whole number');
  });

  it('patches only the fields that changed', () => {
    const original = {
      ...Object.fromEntries(Object.keys(EMPTY_FORM).map((key) => [key, null])),
      company: 'Acme',
      role: 'SDET',
      status: 'Applied',
      source: 'LinkedIn',
      notes: '',
    } as unknown as ApplicationDetail;
    const input = valid({ ...toFormValues(original), status: 'Screening' });
    expect(toPatch(original, input)).toEqual({ status: 'Screening' });
  });
});

describe('fill from link', () => {
  const preview = {
    jobLink: 'https://jobs.example.com/1',
    company: 'Initech',
    role: 'SDET',
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: 'EUR',
  };

  it('fills only empty fields and never overwrites what was typed', () => {
    const typed = { ...EMPTY_FORM, company: 'My own name for it' };
    const { values, filled } = fillEmpty(typed, preview);
    expect(values).toMatchObject({
      company: 'My own name for it',
      role: 'SDET',
      jobLink: 'https://jobs.example.com/1',
      salaryMin: '120000',
      salaryMax: '150000',
      salaryCurrency: 'EUR',
    });
    expect(filled).toBe(4);
  });

  it('leaves the salary alone when either amount was typed', () => {
    const typed = { ...EMPTY_FORM, salaryMax: '200000' };
    const { values } = fillEmpty(typed, preview);
    expect(values).toMatchObject({ salaryMin: '', salaryMax: '200000', salaryCurrency: 'USD' });
  });
});
