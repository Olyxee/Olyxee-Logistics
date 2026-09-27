---
name: Vercel monorepo build cwd
description: Why Vercel build commands must not assume the repository root is the current directory.
---

For Vercel builds of this monorepo, anchor root-relative shell commands with `pnpm -w exec` rather than assuming the custom build starts at the repository root.

**Why:** A Vercel build successfully compiled the API but then failed to copy its output using a repository-relative path. The build command's current directory was the API artifact directory, not the workspace root.

**How to apply:** Reproduce Vercel build commands from the API artifact directory as well as the repository root. Independently verify the Vercel project's Root Directory setting when diagnosing missing frontend output or serverless functions; the build log alone does not prove what that setting is.