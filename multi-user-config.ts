import { resolve } from "node:path";

export type CodexAccountMode = "shared" | "per-user";

function bool(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes";
}

export type MultiUserConfig = {
  enabled: boolean;
  accountMode: CodexAccountMode;
  dataRoot: string;
  usersRoot: string;
  controlRoot: string;
  authDatabase: string;
  sharedCodexCredentialRef: string | null;
};

export function loadMultiUserConfig(env: NodeJS.ProcessEnv = process.env): MultiUserConfig {
  const dataRoot = resolve(env.CODEX_WEBUI_MULTI_USER_ROOT || "/srv/codex-webui");
  const accountMode = env.CODEX_WEBUI_CODEX_ACCOUNT_MODE === "per-user" ? "per-user" : "shared";
  const enabled = bool(env.CODEX_WEBUI_MULTI_USER);
  return {
    enabled,
    accountMode,
    dataRoot,
    usersRoot: resolve(env.CODEX_WEBUI_USERS_ROOT || `${dataRoot}/users`),
    controlRoot: resolve(env.CODEX_WEBUI_CONTROL_ROOT || `${dataRoot}/control`),
    authDatabase: resolve(env.CODEX_WEBUI_AUTH_DATABASE || `${dataRoot}/control/auth.sqlite`),
    sharedCodexCredentialRef: env.CODEX_WEBUI_SHARED_CODEX_CREDENTIAL_REF || null,
  };
}

export function userRuntimePaths(config: MultiUserConfig, userId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(userId)) throw new Error("Invalid user id");
  const root = resolve(config.usersRoot, userId);
  return {
    root,
    workspace: resolve(root, "workspace"),
    codexHome: resolve(root, "codex-home"),
    uploads: resolve(root, "uploads"),
    tmp: resolve(root, "tmp"),
    metadata: resolve(root, "metadata"),
  };
}
