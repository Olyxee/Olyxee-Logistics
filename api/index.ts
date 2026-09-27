// Vercel type-checks this function separately from the API workspace, without
// its Node type declarations. Its generated handler runs as CommonJS.
declare const __dirname: string;

type ExpressApp = (req: unknown, res: unknown) => unknown;
type AppModule = { default: ExpressApp };

// Vercel compiles api/index.ts as CommonJS. Keep this import native at runtime:
// a compiled `import()` can become `require()`, which cannot load app.mjs.
const importEsm = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<AppModule>;

let appPromise: Promise<AppModule> | undefined;

export default async function handler(req: unknown, res: unknown) {
  appPromise ??= importEsm(
    `file://${__dirname}/_bundle/app.mjs`,
  );
  const { default: app } = await appPromise;
  return app(req, res);
}