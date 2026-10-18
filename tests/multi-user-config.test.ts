import { expect, test } from "bun:test";
import { loadMultiUserConfig, userRuntimePaths } from "../multi-user-config.ts";

test("loads shared and per-user account modes from server configuration", () => {
  const shared = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER: "true", CODEX_WEBUI_MULTI_USER_ROOT: "/srv/webui", CODEX_WEBUI_CODEX_ACCOUNT_MODE: "shared" });
  expect(shared).toMatchObject({ enabled: true, accountMode: "shared", dataRoot: "/srv/webui", usersRoot: "/srv/webui/users", authDatabase: "/srv/webui/control/auth.sqlite" });
  const isolated = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER: "1", CODEX_WEBUI_MULTI_USER_ROOT: "/srv/webui", CODEX_WEBUI_CODEX_ACCOUNT_MODE: "per-user" });
  expect(isolated.accountMode).toBe("per-user");
});

test("derives isolated runtime paths from a validated user id", () => {
  const config = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER_ROOT: "/srv/webui" });
  expect(userRuntimePaths(config, "user-1")).toMatchObject({ root: "/srv/webui/users/user-1", workspace: "/srv/webui/users/user-1/workspace", codexHome: "/srv/webui/users/user-1/codex-home" });
  expect(() => userRuntimePaths(config, "../escape")).toThrow("Invalid user id");
});
