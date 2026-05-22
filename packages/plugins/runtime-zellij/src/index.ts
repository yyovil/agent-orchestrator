import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type AttachInfo,
  isMac,
  isWindows,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  shellEscape,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);
const ZELLIJ_COMMAND_TIMEOUT_MS = 5_000;
const ZELLIJ_PASTE_CHUNK_SIZE = 16_000;
const DEFAULT_ZELLIJ_SOCKET_DIR = `/tmp/aoz${userInfo().uid}`;

export const manifest = {
  name: "zellij",
  slot: "runtime" as const,
  description: "Runtime plugin: Zellij sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/**
 * Keep the Zellij pane usable after the agent exits. This mirrors the tmux
 * runtime's durability semantics: AO can detect the agent process exit while
 * the runtime session itself remains available for inspection and recovery.
 */
const KEEP_ALIVE_SHELL = `exec "\${SHELL:-/bin/bash}" -i`;

function withKeepAliveShell(command: string): string {
  return `${command.replace(/\n+$/, "")}\n${KEEP_ALIVE_SHELL}`;
}

function writeLaunchScript(command: string): string {
  const scriptPath = join(tmpdir(), `ao-zellij-launch-${randomUUID()}.sh`);
  const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${withKeepAliveShell(command)}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return scriptPath;
}

function kdlString(value: string): string {
  return JSON.stringify(value);
}

function buildLayout(scriptPath: string): string {
  return [
    "layout {",
    `  pane command="bash" {`,
    `    args ${kdlString(scriptPath)}`,
    "  }",
    "}",
  ].join("\n");
}

function zellijEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!env.ZELLIJ_SOCKET_DIR) env.ZELLIJ_SOCKET_DIR = DEFAULT_ZELLIJ_SOCKET_DIR;
  if (env.ZELLIJ_SOCKET_DIR === DEFAULT_ZELLIJ_SOCKET_DIR) {
    mkdirSync(DEFAULT_ZELLIJ_SOCKET_DIR, { recursive: true, mode: 0o700 });
  }
  // If AO itself is running inside Zellij, inherited ZELLIJ_* variables make
  // `zellij --layout ...` add panes to the parent session instead of creating
  // the requested named background session. Clear them for runtime control
  // commands; the agent pane still receives AO/config environment via `extra`.
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  delete env.ZELLIJ_SESSION_NAME;
  return env;
}

/** Run a zellij command and return stdout. */
async function zellij(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; socketDir?: string },
): Promise<string> {
  const env = { ...(options?.env ?? {}) };
  if (options?.socketDir) env.ZELLIJ_SOCKET_DIR = options.socketDir;

  const { stdout } = await execFileAsync("zellij", args, {
    cwd: options?.cwd,
    env: zellijEnv(env),
    timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trimEnd();
}

function getPaneId(handle: RuntimeHandle): string {
  const paneId = handle.data.paneId;
  return typeof paneId === "string" && paneId.length > 0 ? paneId : "0";
}

function socketDirFromUnknown(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_ZELLIJ_SOCKET_DIR;
}

function getSocketDir(handle: RuntimeHandle): string {
  return socketDirFromUnknown(handle.data.socketDir);
}

interface ZellijPaneInfo {
  id?: number | string;
  is_plugin?: boolean;
}

async function getPrimaryPaneId(sessionName: string, socketDir: string): Promise<string> {
  try {
    const output = await zellij(
      ["--session", sessionName, "action", "list-panes", "--json", "--all"],
      { socketDir },
    );
    const panes = JSON.parse(output) as ZellijPaneInfo[];
    const pane = panes.find((entry) => entry.is_plugin !== true && entry.id !== undefined);
    if (pane?.id !== undefined) return String(pane.id);
  } catch {
    // Fall back to Zellij's first terminal pane id.
  }
  return "0";
}

function hasLiveSession(listSessionsOutput: string, sessionName: string): boolean {
  return listSessionsOutput.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const firstToken = trimmed.split(/[\s[]/, 1)[0];
    return firstToken === sessionName && !trimmed.includes("(EXITED");
  });
}

function tailLines(output: string, lines: number): string {
  if (lines <= 0) return "";
  const all = output.split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

function chunkString(value: string, size: number): string[] {
  if (value.length <= size) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

export function create(): Runtime {
  return {
    name: "zellij",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      const pathValue = config.environment?.["PATH"];
      let launchCommand = config.launchCommand;
      if (pathValue) {
        launchCommand = `export PATH=$(printf '%s' ${JSON.stringify(pathValue)})\n${launchCommand}`;
      }

      const scriptPath = writeLaunchScript(launchCommand);
      const layout = buildLayout(scriptPath);
      const socketDir = socketDirFromUnknown(
        config.environment?.ZELLIJ_SOCKET_DIR ?? process.env.ZELLIJ_SOCKET_DIR,
      );
      const controlEnvironment = {
        ...config.environment,
        ZELLIJ_SOCKET_DIR: socketDir,
      };

      try {
        await zellij(["--layout-string", layout, "attach", "--create-background", sessionName], {
          cwd: config.workspacePath,
          env: controlEnvironment,
        });
      } catch (err: unknown) {
        try {
          unlinkSync(scriptPath);
        } catch {
          // The launch script deletes itself when Zellij starts it.
        }
        try {
          await zellij(["kill-session", sessionName]);
        } catch {
          // Best-effort cleanup.
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to launch Zellij session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      const paneId = await getPrimaryPaneId(sessionName, socketDir);

      return {
        id: sessionName,
        runtimeName: "zellij",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
          paneId,
          socketDir,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await zellij(["kill-session", handle.id], { socketDir: getSocketDir(handle) });
      } catch {
        // Session may already be dead — that's fine.
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const paneId = getPaneId(handle);
      const socketDir = getSocketDir(handle);
      await zellij(["--session", handle.id, "action", "send-keys", "--pane-id", paneId, "Ctrl u"], {
        socketDir,
      });
      await sleep(200);

      for (const chunk of chunkString(message, ZELLIJ_PASTE_CHUNK_SIZE)) {
        await zellij(["--session", handle.id, "action", "paste", "--pane-id", paneId, chunk], {
          socketDir,
        });
      }

      await sleep(300);
      await zellij(["--session", handle.id, "action", "send-keys", "--pane-id", paneId, "Enter"], {
        socketDir,
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        const output = await zellij(
          [
            "--session",
            handle.id,
            "action",
            "dump-screen",
            "--full",
            "--pane-id",
            getPaneId(handle),
          ],
          { socketDir: getSocketDir(handle) },
        );
        return tailLines(output, lines);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await zellij(["list-sessions", "--no-formatting"], {
          socketDir: getSocketDir(handle),
        });
        return hasLiveSession(output, handle.id);
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const socketDir = getSocketDir(handle);
      return {
        type: "zellij",
        target: handle.id,
        command: `ZELLIJ_SOCKET_DIR=${shellEscape(socketDir)} zellij attach ${shellEscape(handle.id)}`,
      };
    },

    async preflight(): Promise<void> {
      if (isWindows()) {
        throw new Error(
          "Zellij runtime is not supported on native Windows. Use runtime: process, or run AO inside WSL with zellij installed.",
        );
      }
      try {
        await zellij(["--version"]);
      } catch {
        const hint = isMac()
          ? "brew install zellij"
          : "install zellij from your distro/package manager, or see https://zellij.dev/documentation/installation";
        throw new Error(`zellij is not installed. Install it: ${hint}`);
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
