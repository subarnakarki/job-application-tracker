import fc from 'fast-check';
import type { z } from 'zod';
import { z as zod } from 'zod';

/**
 * fast-check arbitraries built from a zod schema (via zod's JSON Schema output).
 * `validish` aims at inputs the schema would accept (refinements aside), so the
 * fuzzer reaches deep into handlers; `hostile` mixes those with wrong types,
 * missing and extra keys, and arbitrary JSON, to probe validation.
 */

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  [key: string]: unknown;
};

export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return zod.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

/** Strings that tend to break things. */
const NASTY_STRINGS = [
  '',
  ' ',
  '\u0000',
  '\n\r\t',
  "'; drop table applications; --",
  '%_\\',
  '<script>alert(1)</script>',
  'javascript:alert(1)',
  '😀👍🏽',
  '‮​',
  '0000-00-00',
  '2026-02-30',
  '9999-12-31T23:59:59.999Z',
  '+05:00',
  'null',
  '../../etc/passwd',
];

const day = fc
  .date({
    min: new Date('1990-01-01T00:00:00Z'),
    max: new Date('2099-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((value) => value.toISOString().slice(0, 10));
const instant = fc
  .date({
    min: new Date('1990-01-01T00:00:00Z'),
    max: new Date('2099-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((value) => value.toISOString());

function stringArbitrary(schema: JsonSchema): fc.Arbitrary<string> {
  if (schema.format === 'date') return day;
  if (schema.format === 'date-time') return instant;
  if (schema.format === 'uuid') return fc.uuid();
  const minLength = schema.minLength ?? 0;
  const maxLength = Math.min(schema.maxLength ?? 60, 60);
  return fc.oneof(
    {
      weight: 6,
      arbitrary: fc.string({
        minLength: Math.max(1, minLength),
        maxLength: Math.max(1, maxLength),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        'https://acme.example/jobs/1',
        'http://example.com',
        'UTC',
        'USD',
        'America/New_York',
      ),
    },
  );
}

export function validish(schema: JsonSchema, depth = 0): fc.Arbitrary<unknown> {
  if (depth > 6) return fc.constant(null);
  if (schema.const !== undefined) return fc.constant(schema.const);
  if (schema.enum) return fc.constantFrom(...schema.enum);
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return fc.oneof(...options.map((option) => validish(option, depth + 1)));

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return stringArbitrary(schema);
    case 'integer':
      return fc.integer({ min: schema.minimum ?? -1_000_000, max: schema.maximum ?? 1_000_000 });
    case 'number':
      return fc.double({ min: schema.minimum ?? -1e6, max: schema.maximum ?? 1e6, noNaN: true });
    case 'boolean':
      return fc.boolean();
    case 'null':
      return fc.constant(null);
    case 'array':
      return fc.array(validish(schema.items ?? {}, depth + 1), { maxLength: 3 });
    case 'object': {
      const properties = schema.properties ?? {};
      const record: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [key, value] of Object.entries(properties))
        record[key] = validish(value, depth + 1);
      return fc.record(record, {
        requiredKeys: (schema.required ?? []).filter((key) => key in properties),
      });
    }
    default:
      return fc.jsonValue({ maxDepth: 2 });
  }
}

/** Valid-looking input with one thing wrong, or something else entirely. */
export function hostile(schema: JsonSchema): fc.Arbitrary<unknown> {
  const base = validish(schema);
  const keys = Object.keys(schema.properties ?? {});
  const wrongValue = fc.oneof(
    fc.constantFrom<unknown>(...NASTY_STRINGS),
    fc.constantFrom<unknown>(null, true, false, 0, -1, 1.5, 2 ** 53, -(2 ** 53), [], {}, [1, 2]),
    fc.string({ maxLength: 3000 }),
    fc.jsonValue({ maxDepth: 3 }),
  );
  const mutations: fc.Arbitrary<unknown>[] = [
    fc.jsonValue({ maxDepth: 3 }),
    fc.constantFrom<unknown>(null, [], 'text', 42, true),
    fc
      .tuple(base, fc.string({ minLength: 1, maxLength: 20 }), wrongValue)
      .map(([value, key, extra]) =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? { ...value, [key]: extra }
          : value,
      ),
  ];
  if (keys.length > 0) {
    mutations.push(
      fc
        .tuple(base, fc.constantFrom(...keys), wrongValue)
        .map(([value, key, wrong]) =>
          typeof value === 'object' && value !== null ? { ...value, [key]: wrong } : value,
        ),
      fc.tuple(base, fc.constantFrom(...keys)).map(([value, key]) => {
        if (typeof value !== 'object' || value === null) return value;
        const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
        delete copy[key];
        return copy;
      }),
    );
  }
  return fc.oneof(...mutations);
}

/** Path-parameter values: real, missing, and malicious. */
export const idValue = (real: string) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constant(real) },
    { weight: 2, arbitrary: fc.uuid() },
    { weight: 1, arbitrary: fc.constant(real.toUpperCase()) },
    { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 80 }) },
    { weight: 1, arbitrary: fc.constantFrom(...NASTY_STRINGS.filter((value) => value !== '')) },
  );
