// Vercel serverless entrypoint. The /api/* rewrite in vercel.json routes
// API requests to this function, which delegates them to the existing
// Express app.
//
// The app bundle is copied into api/_bundle at build time so this function
// is self-contained inside Vercel's function directory.
// @ts-expect-error -- bundled .mjs has no type declarations
import app from "./_bundle/app.mjs";

export default app;