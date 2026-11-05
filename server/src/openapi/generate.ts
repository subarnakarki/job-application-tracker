import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app';
import { buildOpenApi } from './build';

/** The committed spec. Regenerate with `npm run openapi`; a test fails when it is stale. */
export const SPEC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/openapi.json',
);

/** The public API only: built without test routes, whatever the environment says. */
export async function generateSpec(): Promise<Record<string, unknown>> {
  const app = buildApp({ env: {} });
  await app.ready();
  try {
    return buildOpenApi(app.registeredRoutes);
  } finally {
    await app.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === `file://${entry}`) {
  generateSpec()
    .then((spec) => writeFile(SPEC_PATH, `${JSON.stringify(spec, null, 2)}\n`))
    .then(() => console.log(`Wrote ${SPEC_PATH}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
