// Vite's `import.meta.glob`, so only suites that Vitest runs import this module.
// A fixture run in its own Node process takes its sources from
// `inlineSources.ts`, which reads no glob.

/**
 * The `plain` local-backend fixture's module sources, by file name, for a test
 * that loads one of those files as a module.
 */
const plainFiles = import.meta.glob<string>(
  "../../../../tools/local-backend/fixtures/plain/convex/*.ts",
  { query: "?raw", import: "default" },
);

export const plainSource = (file: string): (() => Promise<string>) => {
  const source =
    plainFiles[`../../../../tools/local-backend/fixtures/plain/convex/${file}`];
  if (source === undefined) {
    throw new Error(`The plain fixture has no ${file}.`);
  }
  return source;
};
