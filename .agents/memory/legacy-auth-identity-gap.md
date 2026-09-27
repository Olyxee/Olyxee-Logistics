---
name: Legacy auth identity gap
description: Why a legacy Supabase identity is not enough to grant access to a current app workspace.
---

Old Supabase authentication identities can exist without a matching application user, profile, or verifiable business association. The current login and reset flows use application users, so an old identity alone cannot authenticate or receive an app password-reset email.

**Why:** A production access investigation found an orphaned legacy identity alongside a separate, populated business with its own owner. Linking them by email similarity or a claimed business name would grant access without proof and could expose another tenant's data.

**How to apply:** Diagnose both identity stores with read-only checks. Require a verified account-to-business mapping and explicit authorization before migrating or granting tenant access. Prefer recovering a confirmed existing owner account over creating an unlinked duplicate.