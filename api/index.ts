import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ExpressApp = (
  req: IncomingMessage,
  res: ServerResponse,
) => unknown;
type AppModule = { default: ExpressApp };

// Vercel compiles api/index.ts as CommonJS. Keep this import native at runtime:
// a compiled `import()` can become `require()`, which cannot load app.mjs.
const importEsm = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<AppModule>;

let appPromise: Promise<AppModule> | undefined;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  appPromise ??= importEsm(
    pathToFileURL(resolve(__dirname, "_bundle/app.mjs")).href,
  );
  const { default: app } = await appPromise;
  return app(req, res);
}