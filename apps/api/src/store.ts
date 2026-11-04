import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseRunIntegrity, storedStateSchema } from "@vuzmi/core";
import type { StoredState } from "@vuzmi/core";

export const STATE_FILE_NAME = "workspace.json";

function validateState(value: unknown): StoredState {
  const parsed = storedStateSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "The local state file has an unsupported or invalid schema. Refusing to overwrite it.",
    );
  const ids = new Set<string>();
  for (const run of parsed.data.runs) {
    if (ids.has(run.id))
      throw new Error(
        "The local state file contains duplicate run IDs. Refusing to overwrite it.",
      );
    ids.add(run.id);
    if (run.events.some((event, index) => event.sequence !== index + 1)) {
      throw new Error(
        "The local state file contains an invalid event sequence. Refusing to overwrite it.",
      );
    }
    try {
      parseRunIntegrity(run, (value) =>
        createHash("sha256").update(value).digest("hex"),
      );
      if (run.mode !== "simulation")
        throw new Error("Live execution requires PostgreSQL.");
    } catch {
      throw new Error(
        "The local state file contains inconsistent approval or artifact data. Refusing to overwrite it.",
      );
    }
  }
  return parsed.data;
}

/** A single-process development adapter; not a multi-process database or queue. */
export class LocalStateStore {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dataDir: string,
    private state: StoredState,
  ) {}

  static async load(dataDir: string): Promise<LocalStateStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const directory = await stat(dataDir);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
      throw new Error(
        "The local data directory must be a private directory (permissions 0700).",
      );
    }

    const statePath = join(dataDir, STATE_FILE_NAME);
    let content: string;
    try {
      content = await readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = new LocalStateStore(dataDir, {
        schemaVersion: 1,
        runs: [],
      });
      await initial.persist(initial.state);
      return initial;
    }

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error(
        "The local state file is not valid JSON. Refusing to overwrite it.",
      );
    }
    return new LocalStateStore(dataDir, validateState(value));
  }

  snapshot(): StoredState {
    return structuredClone(this.state);
  }

  async idle(): Promise<void> {
    await this.pending;
  }

  mutate<T>(
    update: (current: StoredState) => { state: StoredState; result: T },
  ): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = update(this.snapshot());
      const validated = validateState(next.state);
      await this.persist(validated);
      // Readers must never observe a transition whose disk write failed.
      this.state = validated;
      return structuredClone(next.result);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(state: StoredState): Promise<void> {
    const temporaryPath = join(this.dataDir, `.workspace-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, join(this.dataDir, STATE_FILE_NAME));
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
