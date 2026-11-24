import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    'build/**',
    'api/index.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [jsxA11y.flatConfigs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // A deepeval metric built without a model falls back to OpenAI, so judge metrics and judge models
    // are built only in evals/src/judge.ts, which always passes the Claude judge.
    files: ['evals/**/*.ts'],
    ignores: ['evals/src/judge.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'deepeval/metrics',
              message: 'Build judge metrics with the factories in evals/src/judge.ts.',
            },
            {
              name: 'deepeval/models',
              message: 'The judge model is ClaudeJudge in evals/src/judge.ts.',
            },
            {
              name: 'deepeval',
              importNames: ['metrics'],
              message: 'Build judge metrics with the factories in evals/src/judge.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JS config files are not part of any tsconfig.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
