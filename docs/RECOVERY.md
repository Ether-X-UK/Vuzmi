# Native backup and recovery

Status: implemented private PostgreSQL 16 recovery tooling, validated with two disposable native clusters and synthetic business/authentication fixtures. This does not establish a production RPO, RTO, encrypted off-site backup service, or point-in-time recovery capability.

## What is backed up

`scripts/backup.mjs` takes a custom-format whole-database `pg_dump` snapshot and writes a private bundle under ignored `.data/backups/` by default:

| File            | Contents                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.dump` | Runtime/queue/auth schemas, source originals and revisions, vector chunks/profiles, curated memories, retained run evidence, proposals, approved artifacts, fingerprints, revisions, events, owner binding, password hashes, and sessions present at the snapshot |
| `auth-secret`   | The original Better Auth secret required to recover the installation's authentication state                                                                                                                                                                       |
| `manifest.json` | Format/PostgreSQL version, completion timestamp, schema names, byte lengths, and SHA-256 checksums; no connection URL or credentials                                                                                                                              |

Directories must be owned by the current user with mode `0700`; files must be regular, owned files with mode `0600`. Symlink bundle entries are rejected. The manifest is written last; a bundle without a valid manifest is incomplete. Checksums detect damage; they do not authenticate a malicious replacement of both the dump and manifest. Restore only backups from a trusted installation. PostgreSQL archives can execute source-defined SQL during restoration. [PostgreSQL pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

**The bundle is not encrypted.** Its database, session state, and adjacent auth secret are sensitive. Keep it on protected local storage and arrange encrypted storage/transport and separately protected key recovery before using backups off-host. No upload or automatic retention/deletion is performed.

This is one database, not a PostgreSQL cluster backup: server roles, original ownership/grants, tablespaces, server configuration, and WAL/PITR are outside it. External artifact volumes, the optional simulation JSON store, application configuration, owner setup key, database credentials, Ollama binaries/model weights, and future external connector secrets are not copied automatically. Current live artifacts and RAG text/vectors are inside PostgreSQL. Preserve any later external files and encryption keys through their own tested recovery path.

## Create a backup

Requirements: Node 22, installed project dependencies, PostgreSQL 16 `pg_dump`/`pg_restore` on `PATH`, a reachable source database, and the source installation's original auth secret. The source database role must be able to read the whole application database.

Stop API and worker processes gracefully, leaving PostgreSQL available. The backup command does not stop or start services. PostgreSQL supports a consistent snapshot while clients are active, but stopping application writes makes the operator's recovery boundary easier to review. The snapshot is taken during `pg_dump`, before the manifest completion time.

```sh
node scripts/backup.mjs
```

The command reads existing `.env` and private `.data/dev/database.env` using the same exported-variable precedence as local startup. It requires `DATABASE_URL`; it reads `BETTER_AUTH_SECRET` or the private `.data/dev/auth-secret` file. The environment may override `VUZMI_BACKUP_DIR`, `VUZMI_QUEUE_SCHEMA` (default `vuzmi_queue`), and `VUZMI_RUNTIME_SCHEMA` (default `vuzmi`). Connection URLs must name a host, user, and database; only the optional `sslmode` query parameter is supported in this native increment. No URL/password is passed as a command argument or printed.

The completed bundle path is printed. A failed operation removes only the new incomplete bundle it created. Existing bundles and database data are not removed. Keep at least one independently recoverable copy; a local disk failure can remove both database and local backup. Scheduled encrypted backups and restore monitoring remain operational release gates.

## Restore into a separate empty target

The operator or database administrator provisions the target first. Use a separately configured PostgreSQL 16 database, with its own connection credentials and pgvector installed in `public` for the same PostgreSQL major version. Keep application services and other clients disconnected. Use the matching application/dependency revision; migrations refuse mismatched checksums.

Set `VUZMI_RESTORE_DATABASE_URL` privately in the environment to this **separate target**, then run:

```sh
node scripts/restore.mjs /absolute/private/path/to/backup-bundle
```

`DATABASE_URL` is never used as a restore fallback. The command refuses the configured source endpoint, built-in administration/template databases, targets with application schemas/objects/data, unsupported extensions, connected clients, invalid permissions, and damaged bundles. An empty target may contain the normal `public` schema and preinstalled `plpgsql`/`vector` extensions. It does not wipe a target or provide an overwrite flag.

Restoration uses `pg_restore --single-transaction --no-owner --no-privileges --no-comments --exit-on-error`. It never uses `--clean` or `--create`. Database comments, source ownership, and source grants are not replayed; the target role owns newly restored application objects. Omitting comments also permits the administrator-owned, preinstalled vector extension to remain in place. A restore error rolls back the archive transaction. [PostgreSQL pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)

After the archive succeeds, a separate recovery transaction cancels restored pending/active generation and indexing jobs and clears stale worker heartbeats. This preserves exact run evidence, approved artifacts, decisions, event history, sources, memories, profiles, and auth ownership. It prevents a later worker start from replaying restored inference. No API, worker, Ollama, model pull, or cloud request is started by the tool.

Development jobs are also quarantined, runtime readiness is cleared and active/recovering attempts are closed. A restored database must not try to clean up execution names on the original host or resume unknown model/check work. Exact approved development packages and append-only events survive restoration. Runner configuration, VM images and model weights are operator prerequisites outside the backup; provision and verify them independently on the new host. Old backups without development tables remain supported.

If quarantine fails after the archive transaction, the command reports that specific incomplete recovery. Keep services stopped. The target is now nonempty and will refuse a second restore; inspect/repair it privately or provision another empty disposable target. There is no destructive retry option.

## Before serving recovered data

1. Keep the source and recovered installations isolated. Do not run both against the same operational integrations. Verify the intended target configuration; the tool does not switch the operator's active database or overwrite its auth-secret file.
2. Install the original bundled auth secret into the **new installation's** protected secret configuration. Local file configuration uses private `.data/dev/auth-secret`; preserve the original secret exactly when using an environment/secret manager. Do not bootstrap a replacement owner. The restored immutable user ID remains the workspace owner.
3. Revoke all restored sessions before exposing the recovered API. A snapshot can restore sessions that were revoked after the backup. Through a private administrative database connection, delete rows from `vuzmi_auth."session"` (adjust only for the configured auth schema), then require fresh owner login. This changes session state without changing the owner or password hash. The drill also verifies the official authenticated `/api/auth/revoke-sessions` path.
4. Verify the source text and active revision, memory provenance/expiry, embedding model digest/dimensions/prompt version, retained evidence, approved artifact content/fingerprint, run revision/events, owner binding, and absence of live restored inference jobs. Restore does not rebuild embeddings or download replacement models. A model/profile mismatch must fail closed.
5. Review all pending/interrupted work. Restored jobs are cancelled, not silently replayed. Old nonterminal source/run records become visible terminal failures through runtime reconciliation once its ten-minute stale-work grace is exceeded; starting a new mission or source revision requires an explicit operator choice.
6. Reapply deletions and session/security changes made after the snapshot before granting access. Source deletion removes live text/vectors/linked memories in the current database; a pre-deletion backup contains those records and can restore them. Historical run evidence/artifacts are retained under the private-alpha policy. Automatic cross-backup erasure, durable deletion replay, and production retention policy are not implemented.
7. Start the recovered API/worker only after these checks. Keep loopback/private network policy intact and perform a fresh owner login and local workflow smoke check. Test any future external effects separately before authorizing replay.

The architecture's daily encrypted-backup and four-hour recovery figures remain targets requiring operational scheduling, encryption, representative data volumes, disaster drills, and measured evidence. This local fixture rehearsal does not establish those guarantees.

## Isolated recovery drill

```sh
node --import tsx scripts/test-recovery.mjs
```

The test starts two new password-protected, loopback-only PostgreSQL 16 clusters beneath an OS temporary directory. It ignores operator database configuration. All passwords, auth secrets, business content, cookies, and backup files are synthetic. Both clusters and their private files are stopped/removed in cleanup.

The drill performs native `pg_dump` and `pg_restore`, rather than mocking archive operations. It checks private permissions and checksum refusal; same-source/nonempty-target refusal without overwriting a marker; exact source/memory/vector restoration; retained evidence, approved artifact, fingerprint, revision and event equality; owner/user binding and session restoration; explicit session revocation; pending-job quarantine and cleared worker readiness. It also demonstrates that deleting a source after backup does not erase that source from the older snapshot. Fixture generation never invokes a model, cloud API, deployment, or external connector.

Suggested package commands: `backup:local`, `restore:local`, and `test:recovery`, mapped to the commands above.
