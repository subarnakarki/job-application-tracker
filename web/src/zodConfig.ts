import { z } from 'zod';

// Our Content-Security-Policy forbids eval. Unless told otherwise, zod probes `new Function` when
// it builds a schema, and the browser reports that blocked probe as a policy violation on every
// page load. This module must be imported before any module that defines schemas (see main.tsx).
z.config({ jitless: true });
