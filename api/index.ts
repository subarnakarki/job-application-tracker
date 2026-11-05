// THROWAWAY (Phase 0.5). Thin stub so Vercel detects the function from git.
// The real handler (Fastify, pg, shared code) is bundled into build/handler.mjs
// by `npm run build:api` during the Vercel build, which runs before functions
// are built. The explicit .mjs extension is required for Node ESM resolution.
// @ts-expect-error build/handler.mjs is generated at build time
export { default } from '../build/handler.mjs';
