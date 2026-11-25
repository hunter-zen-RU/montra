# Montra Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Default-Deny Catch-All**: All unspecified Firestore paths are strictly denied (`allow read, write: if false;`).
2. **PII Isolation**: `/users/{userId}` documents contain verified `email` PII and can only be read or written by the matching authenticated owner (`request.auth.uid == userId`) or a verified bootstrapped admin. Blanket `isSignedIn()` reads and collection-wide `list` queries on `/users` are forbidden.
3. **Master Gate & Identity Integrity**: Every `/users/{userId}/botSnapshots/{snapshotId}`, `/users/{userId}/workspaceNotes/{noteId}`, `/users/{userId}/serviceSync/{serviceId}`, and `/users/{userId}/scopeConfigs/{serviceId}` document requires a verified parent `/users/{userId}` document (`exists(...)` / `get(...)` on write), `ownerId == request.auth.uid`, and `request.auth.token.email_verified == true`.
4. **Prevent Self-Assigned Roles**: New `/users/{userId}` records are locked to `role == 'operator'`; users cannot set `'admin'` or arbitrary fields.
5. **Temporal Integrity & Immutability**: `createdAt` must equal `request.time` on `create` and remain unchanged on `update`; `updatedAt` must equal `request.time` on `create` and `update`; `uid`/`ownerId`/`serviceId` cannot change on `update`.
6. **Terminal State Locking**: Once a `BotSnapshot` reaches `status == 'archived'` or a `WorkspaceNote` reaches `status == 'completed'`, non-admin updates are blocked.
7. **ID Poisoning, Service Allowlist & Payload Size Bounds**: Single-document operations enforce `isValidId()` (`^[a-zA-Z0-9_-]+$`, `<= 128` chars), `/serviceSync/{serviceId}` and `/scopeConfigs/{serviceId}` restrict `serviceId` to `['drive', 'gmail', 'contacts', 'calendar', 'tasks', 'chat']`, and every string/list checks bounded `.size()` (including `scopes` bounded `1..35` with string element checks).

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated read/write**: Read `/users/u1` with `request.auth == null`.
2. **Unverified email write**: Create `/users/u1` with `email_verified: false`.
3. **Cross-user PII peek**: User `u2` calls `get` on `/users/u1`.
4. **Blanket list scrape**: User `u1` calls `list` on `/users`.
5. **Self-assigned admin escalation**: User `u1` creates `/users/u1` with `{ role: "admin" }`.
6. **Shadow/Ghost field injection**: Create `/users/u1/serviceSync/drive` with extra key `oauthToken: "ya29..."`.
7. **Owner spoofing**: User `u1` creates `/users/u1/scopeConfigs/drive` with `ownerId: "u2"`.
8. **Orphaned subcollection write**: Create `/users/u1/scopeConfigs/drive` when `/users/u1` parent document does not exist.
9. **Path ID & Service Allowlist poisoning**: Create `/users/u1/scopeConfigs/unknown` or `/users/u1/botSnapshots/s1$bad`.
10. **Forged timestamp**: Create `/users/u1/workspaceNotes/n1` with client-supplied past `createdAt` (`!= request.time`).
11. **Value poisoning on whitelisted key**: Update `/users/u1/scopeConfigs/drive` with `scopes: []` or >35 items or invalid `profile: "superuser"`.
12. **Terminal state mutation**: Update `/users/u1/workspaceNotes/n1` after `existing().status == "completed"`.
