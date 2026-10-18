import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { userRuntimePaths, type MultiUserConfig, type CodexAccountMode } from "./multi-user-config.ts";

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

type RuntimeClient = (payload: unknown) => void;

export class UserRuntime {
  readonly userId: string;
  readonly accountMode: CodexAccountMode;
  readonly paths: ReturnType<typeof userRuntimePaths>;
  #clients = new Set<RuntimeClient>();

  constructor({ userId, config }: { userId: string; config: MultiUserConfig }) {
    this.userId = userId;
    this.accountMode = config.accountMode;
    this.paths = userRuntimePaths(config, userId);
    for (const path of Object.values(this.paths)) { mkdirSync(path, { recursive: true, mode: 0o700 }); try { chmodSync(path, 0o700); } catch {} }
  }

  allowsPath(candidate: string, root: keyof UserRuntime["paths"] = "workspace") {
    const configured = this.paths[root];
    try {
      const canonicalRoot = realpathSync(configured);
      const canonicalCandidate = realpathSync(resolve(candidate));
      return inside(canonicalCandidate, canonicalRoot);
    } catch {
      const normalized = resolve(candidate);
      return inside(normalized, resolve(configured));
    }
  }

  subscribe(client: RuntimeClient) { this.#clients.add(client); return () => this.#clients.delete(client); }
  publish(payload: unknown) { for (const client of this.#clients) client(payload); }
  clientCount() { return this.#clients.size; }
}
