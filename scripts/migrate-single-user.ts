import { loadMultiUserConfig } from "../multi-user-config.ts";
import { MultiUserStore } from "../multi-user-store.ts";
import { migrateSingleUser } from "../migration-service.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const username = argument("--username");
const sourceHome = argument("--source-home") || process.env.CODEX_HOME || `${process.env.HOME || process.cwd()}/.codex`;
const sourceWorkspace = argument("--source-workspace") || process.env.CODEX_WEBUI_CWD || process.cwd();
const password = process.env.CODEX_WEBUI_MIGRATION_PASSWORD;
if (!username || !password) throw new Error("Usage: CODEX_WEBUI_MIGRATION_PASSWORD='...' bun run scripts/migrate-single-user.ts --username <name> [--source-home <path>] [--source-workspace <path>]");

const config = loadMultiUserConfig();
if (!config.enabled) throw new Error("Set CODEX_WEBUI_MULTI_USER=true before migrating single-user data");
const store = new MultiUserStore({ path: config.authDatabase, rootBase: config.usersRoot });
try {
  if (store.getUserByUsername(username)) throw new Error("The target username already exists");
  const user = store.createUser({ username, password });
  try {
    const result = migrateSingleUser({ sourceHome, sourceWorkspace, config, userId: user.id });
    console.log(JSON.stringify({ user, migration: result.marker }, null, 2));
  } catch (error) {
    console.error(`Migration failed after creating ${username}; revoke or remove the account before retrying.`);
    throw error;
  }
} finally { store.close(); }
