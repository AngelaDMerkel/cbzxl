import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { ArchiveError } from "./archive.ts";
import type { Identity } from "./files.ts";
import { contains } from "./config.ts";
import {
  exists,
  hashFile,
  identity,
  safePath,
  sameIdentity,
  syncDirectory,
  syncFile,
} from "./files.ts";
import { json, now, transaction } from "./database.ts";
import { addIssue, recordOutcome } from "./library.ts";
import type { TransferPayload } from "./library.ts";

interface Transfer {
  id: string;
  archive_id: string;
  source_path: string;
  target_path: string;
  temporary_path: string;
  source_hash: string;
  target_hash: string;
  kind: string;
  state: string;
  payload_json: string;
}
export async function unchanged(
  path: string,
  expected: Identity,
  hash: string,
): Promise<void> {
  if (
    !sameIdentity(expected, await identity(path)) ||
    (await hashFile(path)) !== hash ||
    !sameIdentity(expected, await identity(path))
  )
    throw new ArchiveError("changed", "Source changed before replacement");
}

export async function publish(
  db: DatabaseSync,
  source: string,
  target: string,
  candidate: string,
  expected: Identity,
  sourceHash: string,
  payload: TransferPayload,
): Promise<void> {
  await unchanged(source, expected, sourceHash);
  const id = randomUUID(),
    temporary = join(dirname(target), ".cbzxl-" + id + ".tmp");
  let recorded = false,
    staged = false;
  try {
    if (source !== target && (await exists(target)))
      throw new Error("Destination already exists; source was preserved");
    await fs.copyFile(candidate, temporary, constants.COPYFILE_EXCL);
    staged = true;
    await fs.chmod(temporary, (await fs.stat(source)).mode & 0o777);
    await syncFile(temporary);
    const targetHash = await hashFile(temporary);
    if (targetHash !== payload.update.fingerprint)
      throw new Error("Staged output did not match the verified candidate");
    payload.stagedIdentity = await identity(temporary);
    payload.sourceIdentity = expected;
    await unchanged(source, expected, sourceHash);
    db.prepare(
      "INSERT INTO transfers(id,archive_id,source_path,target_path,temporary_path,source_hash,target_hash,kind,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      payload.outcome.archiveId,
      source,
      target,
      temporary,
      sourceHash,
      targetHash,
      payload.update.location,
      json(payload),
      now(),
    );
    recorded = true;
    await finish(db, {
      id,
      archive_id: payload.outcome.archiveId,
      source_path: source,
      target_path: target,
      temporary_path: temporary,
      source_hash: sourceHash,
      target_hash: targetHash,
      kind: payload.update.location,
      state: "prepared",
      payload_json: json(payload),
    });
  } finally {
    if (!recorded && staged) await fs.rm(temporary, { force: true });
  }
}

async function finish(db: DatabaseSync, transfer: Transfer): Promise<void> {
  const payload = JSON.parse(transfer.payload_json) as TransferPayload;
  if (
    !payload?.outcome ||
    !payload.update ||
    payload.outcome.archiveId !== transfer.archive_id ||
    payload.update.fingerprint !== transfer.target_hash ||
    !payload.stagedIdentity ||
    !payload.sourceIdentity ||
    !Number.isSafeInteger(payload.update.size) ||
    payload.update.size < 0 ||
    !Array.isArray(payload.outcome.pages) ||
    !db.prepare("SELECT 1 FROM runs WHERE id=?").get(payload.outcome.runId)
  )
    throw new Error("Transfer history is incomplete or invalid");
  const inplace = transfer.source_path === transfer.target_path;
  const targetExists = await exists(transfer.target_path);
  const targetHash = targetExists ? await hashFile(transfer.target_path) : null;
  if (targetHash !== transfer.target_hash) {
    if (targetExists && !inplace)
      throw new Error("Destination already exists; source was preserved");
    await unchanged(
      transfer.source_path,
      payload.sourceIdentity,
      transfer.source_hash,
    );
    if (
      !(await exists(transfer.temporary_path)) ||
      (await hashFile(transfer.temporary_path)) !== transfer.target_hash
    )
      throw new Error("Verified temporary output is missing or changed");
    if (inplace) await fs.rename(transfer.temporary_path, transfer.target_path);
    else await fs.link(transfer.temporary_path, transfer.target_path);
    await syncDirectory(dirname(transfer.target_path));
  }
  if ((await hashFile(transfer.target_path)) !== transfer.target_hash)
    throw new Error("Published output verification failed");
  const publishedIdentity = await identity(transfer.target_path);
  if (
    publishedIdentity.dev !== payload.stagedIdentity.dev ||
    publishedIdentity.ino !== payload.stagedIdentity.ino ||
    publishedIdentity.size !== payload.update.size
  )
    throw new Error("Destination is not the file published by this transfer");
  db.prepare("UPDATE transfers SET state='published' WHERE id=?").run(
    transfer.id,
  );
  if (!inplace && (await exists(transfer.source_path))) {
    await unchanged(
      transfer.source_path,
      payload.sourceIdentity,
      transfer.source_hash,
    );
    await fs.unlink(transfer.source_path);
    await syncDirectory(dirname(transfer.source_path));
  }
  // Removing the staging hard link changes ctime on the published inode.
  await fs
    .rm(transfer.temporary_path, { force: true })
    .catch((error) =>
      console.warn("Temporary output cleanup failed: " + String(error)),
    );
  payload.update.identityJson = json(await identity(transfer.target_path));
  transaction(db, () => {
    if (!db.prepare("SELECT id FROM transfers WHERE id=?").get(transfer.id))
      return;
    recordOutcome(db, payload.outcome, payload.update);
    db.prepare("DELETE FROM transfers WHERE id=?").run(transfer.id);
  });
}

export async function recoverTransfers(
  db: DatabaseSync,
  config: Config,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (const transfer of db
    .prepare("SELECT * FROM transfers ORDER BY created_at")
    .all() as unknown as Transfer[]) {
    try {
      const roots = [config.source, config.converted, config.quarantine].filter(
        (value): value is string => Boolean(value),
      );
      if (
        !roots.some((root) => contains(root, transfer.source_path)) ||
        !roots.some((root) => contains(root, transfer.target_path)) ||
        dirname(transfer.temporary_path) !== dirname(transfer.target_path) ||
        !transfer.temporary_path.endsWith(transfer.id + ".tmp")
      )
        throw new Error("Transfer paths do not match the configured library");
      for (const path of [
        transfer.source_path,
        transfer.target_path,
        transfer.temporary_path,
      ]) {
        const root = roots
          .filter((root) => contains(root, path))
          .sort((a, b) => b.length - a.length)[0]!;
        await safePath(root, relative(root, path));
      }
      await finish(db, transfer);
    } catch (error) {
      blocked.add(transfer.source_path);
      blocked.add(transfer.target_path);
      db.prepare("UPDATE transfers SET state='blocked' WHERE id=?").run(
        transfer.id,
      );
      addIssue(
        db,
        transfer.archive_id,
        "transfer_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return blocked;
}
