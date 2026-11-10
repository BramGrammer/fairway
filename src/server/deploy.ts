import { CaddyAdmin, type Warning } from "./caddy-admin.js";
import { hashText, readCaddyfile, writeInPlace } from "./caddyfile.js";
import type { EventTracker } from "./events.js";
import type { RevisionMeta, Store } from "./store.js";

export type DeployFailure =
  | { code: "conflict"; message: string; currentText: string; currentHash: string }
  | { code: "invalid"; message: string }
  | { code: "load_failed"; message: string }
  | { code: "restore_failed"; message: string };

export class DeployError extends Error {
  constructor(readonly failure: DeployFailure) {
    super(failure.message);
  }
}

export interface DeployRequest {
  text: string;
  /** Hash of the file as the editor last saw it. */
  baseHash: string;
  /** Overwrite even though the file changed outside the editor. */
  force?: boolean;
  note?: string;
  rollbackOf?: RevisionMeta["rollbackOf"];
}

export interface DeployResult {
  revision: RevisionMeta;
  /** The text matched the latest Revision, so no new one was recorded. */
  unchanged: boolean;
  warnings: Warning[];
}

export class Deployer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly caddyfilePath: string,
    private readonly admin: CaddyAdmin,
    private readonly store: Store,
    /** Where outcomes worth remembering (a refused reload, an outside edit, a Rollback) are recorded. */
    private readonly events?: EventTracker,
  ) {}

  /** Saves the live file as the Original the first time the editor sees it. */
  async ensureOriginal(): Promise<void> {
    if ((await this.store.getOriginal()) !== null) return;
    await this.store.saveOriginal((await readCaddyfile(this.caddyfilePath)).text);
  }

  current() {
    return readCaddyfile(this.caddyfilePath);
  }

  async validate(text: string) {
    if (text.trim() === "") return { ok: false as const, error: "The Caddyfile is empty." };
    return this.admin.adapt(text);
  }

  /** Validate, back up, write, reload. One at a time, restoring the old file if the reload fails. */
  deploy(request: DeployRequest): Promise<DeployResult> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(request: DeployRequest): Promise<DeployResult> {
    const previous = await this.current();

    if (previous.hash !== request.baseHash && !request.force) {
      throw new DeployError({
        code: "conflict",
        message: "The Caddyfile changed outside the editor.",
        currentText: previous.text,
        currentHash: previous.hash,
      });
    }

    const checked = await this.validate(request.text);
    if (!checked.ok) throw new DeployError({ code: "invalid", message: checked.error });

    if (previous.hash !== request.baseHash) {
      await this.keepExternalEdit(previous);
      this.events?.record("external_edit", "The Caddyfile was changed outside Fairway; that version was saved before it was overwritten");
    }

    await writeInPlace(this.caddyfilePath, request.text);

    const loaded = await this.admin.load(request.text);
    if (!loaded.ok) {
      try {
        await writeInPlace(this.caddyfilePath, previous.text);
      } catch (error) {
        this.events?.record("deploy_failed", "Caddy refused the reload and the previous Caddyfile could not be restored");
        throw new DeployError({
          code: "restore_failed",
          message: `Reload failed (${loaded.error}) and the previous file could not be restored: ${(error as Error).message}`,
        });
      }
      this.events?.record("deploy_failed", "Caddy refused the reload; the previous Caddyfile was restored");
      throw new DeployError({ code: "load_failed", message: loaded.error });
    }
    if (request.rollbackOf !== undefined) this.events?.record("rollback", request.note?.trim() || "Rolled back to an earlier Revision");

    const latest = this.store.latestDeployed();
    const hash = hashText(request.text);
    if (latest?.hash === hash) {
      return { revision: latest, unchanged: true, warnings: checked.warnings };
    }
    const revision = await this.store.add(request.text, {
      hash,
      kind: "deployed",
      note: request.note?.trim() ?? "",
      ...(request.rollbackOf !== undefined && { rollbackOf: request.rollbackOf }),
    });
    return { revision, unchanged: false, warnings: checked.warnings };
  }

  /** An edit made outside the editor is snapshotted before it gets overwritten, so it is never lost. */
  private async keepExternalEdit(file: { text: string; hash: string }): Promise<void> {
    const alreadyKept = this.store.list().some((revision) => revision.hash === file.hash);
    if (alreadyKept) return;
    await this.store.add(file.text, {
      hash: file.hash,
      kind: "external",
      note: "Changed outside the editor, saved before it was overwritten",
    });
  }
}
