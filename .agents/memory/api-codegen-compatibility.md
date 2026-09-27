---
name: API codegen compatibility
description: Dependency compatibility when regenerating OpenAPI client and validation schemas
---

**Rule:** Keep generated validation schemas on Zod 4 while keeping the rest of the application on its existing Zod version; generated fetch client compilation needs DOM.Iterable in its TypeScript libraries.
**Why:** The package firewall rejected older Orval tarballs during a fresh install. A newer allowed release generated APIs using Zod 4-only methods and iterated Headers objects, while application code still relied on Zod 3. Updating Zod across the whole app would be a riskier migration.
**How to apply:** When regenerating the API, check the generator's current output against the isolated validation package dependency and run shared-library typechecking before changing unrelated application dependencies.