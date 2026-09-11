// 路径常量、端口、数据目录
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackagedAsar = __dirname.includes(".asar");

export const ROOT_DIR = join(__dirname, "..");
export const PUBLIC_DIR = join(ROOT_DIR, "public");

// 在打包的 app.asar 模式下，data 目录必须重定向到用户可写路径，避免 ENOTDIR
export const DATA_DIR =
  process.env.DATA_DIR ||
  (isPackagedAsar
    ? join(
        homedir(),
        "Library",
        "Application Support",
        "ai-sub-dashboard",
        "data",
      )
    : join(ROOT_DIR, "data"));

export const PORT = Number(process.env.PORT || 4780);
export const HOST = "127.0.0.1";
export const RESCAN_INTERVAL_MS = Number(
  process.env.RESCAN_INTERVAL_MS || 5 * 60 * 1000,
);

export const CLAUDE_DIR = process.env.CLAUDE_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_DIR || join(homedir(), ".codex");
export const OPENCODE_DB =
  process.env.OPENCODE_DB ||
  join(homedir(), ".local/share/opencode/opencode.db");
export const PI_DIR = process.env.PI_DIR || join(homedir(), ".pi");

export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const SNAPSHOT_PATH = join(DATA_DIR, "snapshot.json");
export const AGY_DIR =
  process.env.AGY_DIR || join(homedir(), ".gemini", "antigravity-cli");
export const CURSOR_DIR =
  process.env.CURSOR_DIR ||
  join(homedir(), "Library", "Application Support", "Cursor");
export const CURSOR_DB =
  process.env.CURSOR_DB ||
  join(CURSOR_DIR, "User", "globalStorage", "state.vscdb");
export const PROVIDERS_PATH = join(DATA_DIR, "providers.json");

// 联机 Hub 默认服务器(内网): 开箱即用, 用户无需手动填写; 可用环境变量覆盖
export const DEFAULT_HUB_URL = process.env.DEFAULT_HUB_URL || '';
export const DEFAULT_HUB_TOKEN = process.env.DEFAULT_HUB_TOKEN || '';
