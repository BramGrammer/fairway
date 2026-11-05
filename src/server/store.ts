import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RevisionMeta {
  id: number;
  createdAt: string;
  hash: string;
  note: string;
  /** deployed: applied to Caddy by the editor. external: found on disk, changed outside the editor. */
  kind: "deployed" | "external";
  rollbackOf?: number | "original";
}

interface Index {
  nextId: number;
  revisions: RevisionMeta[];
}

/** Keeps the Original and Revisions in the editor's own volume, never in the mounted Caddyfile. */
export class Store {
  private index: Index = { nextId: 1, revisions: [] };

  constructor(
    private readonly dir: string,
    private readonly maxRevisions: number,
  ) {}

  private get originalPath() {
    return join(this.dir, "original.caddyfile");
  }
  private get indexPath() {
    return join(this.dir, "index.json");
  }
  private revisionPath(id: number) {
    return join(this.dir, "revisions", `${id}.caddyfile`);
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, "revisions"), { recursive: true });
    try {
      this.index = JSON.parse(await readFile(this.indexPath, "utf8")) as Index;
    } catch {
      await this.saveIndex();
    }
  }

  private async saveIndex(): Promise<void> {
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.index, null, 2));
    await rename(tmp, this.indexPath);
  }

  async getOriginal(): Promise<string | null> {
    try {
      return await readFile(this.originalPath, "utf8");
    } catch {
      return null;
    }
  }

  /** The Original is written once and never changed or pruned. */
  async saveOriginal(text: string): Promise<void> {
    await writeFile(this.originalPath, text, { flag: "wx" });
  }

  /** Newest first. */
  list(): RevisionMeta[] {
    return [...this.index.revisions].reverse();
  }

  latestDeployed(): RevisionMeta | undefined {
    return this.list().find((revision) => revision.kind === "deployed");
  }

  async add(text: string, meta: Omit<RevisionMeta, "id" | "createdAt">): Promise<RevisionMeta> {
    const revision: RevisionMeta = {
      id: this.index.nextId++,
      createdAt: new Date().toISOString(),
      ...meta,
    };
    await writeFile(this.revisionPath(revision.id), text);
    this.index.revisions.push(revision);
    await this.prune();
    await this.saveIndex();
    return revision;
  }

  async get(id: number): Promise<{ meta: RevisionMeta; text: string } | null> {
    const meta = this.index.revisions.find((revision) => revision.id === id);
    if (!meta) return null;
    return { meta, text: await readFile(this.revisionPath(id), "utf8") };
  }

  /** Each kind keeps its own last N, so outside edits never push out deployed Revisions. */
  private async prune(): Promise<void> {
    for (const kind of ["deployed", "external"] as const) {
      const ofKind = this.index.revisions.filter((revision) => revision.kind === kind);
      for (const stale of ofKind.slice(0, Math.max(0, ofKind.length - this.maxRevisions))) {
        await rm(this.revisionPath(stale.id), { force: true });
        this.index.revisions = this.index.revisions.filter((revision) => revision.id !== stale.id);
      }
    }
  }
}
