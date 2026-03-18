import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Enable type-aware linting (required for no-floating-promises, no-misused-promises)
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent-generated workspace and runtime data
    "data/**",
    "artifacts/**",
    ".workbench/**",
    // Git worktrees (created by parallel agent workflows)
    ".worktrees/**",
  ]),
  // Prevent console.* in server-side code — use `import { log } from '@/lib/server/logger'` instead.
  {
    files: ["src/lib/server/**/*.ts", "src/lib/providers/**/*.ts", "src/app/api/**/*.ts", "src/instrumentation.ts"],
    ignores: ["**/*.test.ts", "src/lib/server/logger.ts"],
    rules: {
      "no-console": "warn",
    },
  },
  // Async safety — catch silently dropped promises and misused async functions.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
]);

export default eslintConfig;
