---
name: GitHub writes from Replit
description: How to publish repository changes when the Git CLI can fetch but cannot authenticate for pushes.
---

The Git CLI may successfully fetch a public GitHub repository while rejecting pushes because no writable credential is configured. Use the attached GitHub connection’s SDK and the Git Data API to create blobs, a tree, one commit, and a non-forced ref update.

**Why:** This preserves a single atomic commit and avoids exposing credentials or using force-push when direct Git authentication is unavailable.

**How to apply:** Verify the remote head still equals the validated base commit, restrict the tree entries to the approved path allowlist, and update `heads/main` with `force: false`. Fetch and align local `main` after success.

A narrow remote commit can trigger an automatic rebase of the local Replit checkpoint history, even when the working tree was clean before the remote write.

**Why:** The remote branch and local checkpoint commits diverge when only an approved subset of local changes is published.

**How to apply:** Inspect local Git state after a remote write; finish any in-progress sync while preserving the intended local files before continuing or declaring completion.