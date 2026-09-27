---
name: Migration backup provenance
description: Why the existing recovery backup is not the latest version of the Olyxee app.
---
**Rule:** Treat the working root tree as the current app; use the recovery backup only to inspect or recover missing content, not as a source to overwrite the root wholesale.

**Why:** The imported workspace already contained an extensively developed Vite + pnpm app, while the backup captured an older version. Blindly rerunning the generic frontend copy step would erase newer screens, assets, API routes, and business logic.

**How to apply:** When revisiting import or recovery work, compare the current tree with the backup before copying. Keep the existing artifact structure if it already runs, and migrate only remaining platform-specific pieces.