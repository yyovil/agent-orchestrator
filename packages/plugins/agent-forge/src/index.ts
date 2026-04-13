import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  buildAgentPath,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  PREFERRED_GH_PATH,
  asValidForgeSessionId,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
  type ForgeAgentConfig,
} from "@aoagents/ao-core";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import which from "which";

const execFileAsync = promisify(execFile);
const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const MODEL_SEPARATE_RE = /^\S+\s+.+$/;
const FORGE_COMMAND_TIMEOUT_MS = 30_000;

async function runForgeCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("forge", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeout ?? FORGE_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (!timedOut && code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const commandLabel = `forge ${args.join(" ")}`;
      const detail = stderr.trim() || stdout.trim();
      if (timedOut) {
        reject(new Error(`Command timed out: ${commandLabel}`));
        return;
      }

      reject(
        new Error(
          detail.length > 0
            ? `Command failed: ${commandLabel}\n${detail}`
            : `Command failed: ${commandLabel}${signal ? ` (${signal})` : ""}`,
        ),
      );
    });
  });
}

function parseForgeModelArgs(raw: string): [provider: string, model: string] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid Forge model format: "${raw}". Use "<provider> <model>" or "<provider>/<model>".`);
  }

  if (trimmed.includes("/")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === 0 || slashIndex === trimmed.length - 1) {
      throw new Error(
        `Invalid Forge model format: "${raw}". Use "<provider> <model>" or "<provider>/<model>".`,
      );
    }
    const provider = trimmed.slice(0, slashIndex);
    const model = trimmed.slice(slashIndex + 1);
    if (!MODEL_RE.test(provider) || !model.trim()) {
      throw new Error(
        `Invalid Forge model format: "${raw}". Use "<provider> <model>" or "<provider>/<model>".`,
      );
    }
    return [provider, model];
  }

  if (!MODEL_SEPARATE_RE.test(trimmed)) {
    throw new Error(`Invalid Forge model format: "${raw}". Use "<provider> <model>" or "<provider>/<model>".`);
  }
  const [provider, ...rest] = trimmed.split(/\s+/);
  const model = rest.join(" ");
  if (!provider || !MODEL_RE.test(provider) || !model.trim()) {
    throw new Error(`Invalid Forge model format: "${raw}". Use "<provider> <model>" or "<provider>/<model>".`);
  }
  return [provider, model];
}

function renderForgeModelForShell(raw: string): string {
  const [provider, model] = parseForgeModelArgs(raw);
  return `${shellEscape(provider)} ${shellEscape(model)}`;
}

function parseConversationSummaryFromText(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx > -1 && line.slice(0, idx).trim().toLowerCase() === "summary") {
      const value = line.slice(idx + 1).trim();
      if (value) return value;
    }
  }

  const fencedSummaryIndex = lines.findIndex((line) => /^#+\s*summary/i.test(line));
  if (fencedSummaryIndex !== -1) {
    const next = lines[fencedSummaryIndex + 1];
    return next && !/^#+\s*/.test(next) ? next : null;
  }

  return lines[0] ?? null;
}

function extractFirstMeaningfulMarkdownLine(markdown: string): string | null {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#+\s*/.test(line) && line !== "---");
  return lines[0] ?? null;
}

async function fetchForgeConversationSummary(
  conversationId: string,
): Promise<{ summary: string | null; summaryIsFallback?: boolean }> {
  try {
    const { stdout } = await runForgeCommand(["conversation", "show", "--md", conversationId], {
      timeout: FORGE_COMMAND_TIMEOUT_MS,
    });
    const parsed = extractFirstMeaningfulMarkdownLine(stdout);
    if (parsed) return { summary: parsed, summaryIsFallback: false };
  } catch {
    // fallback
  }

  try {
    const { stdout } = await runForgeCommand(["conversation", "info", conversationId], {
      timeout: FORGE_COMMAND_TIMEOUT_MS,
    });
    const parsed = parseConversationSummaryFromText(stdout);
    return { summary: parsed, summaryIsFallback: true };
  } catch {
    return { summary: null };
  }
}

interface ForgeConversationStats {
  updatedAt?: Date;
}

async function fetchForgeConversationStats(conversationId: string): Promise<ForgeConversationStats | null> {
  try {
    const { stdout } = await runForgeCommand(["conversation", "stats", "--porcelain", conversationId], {
      timeout: FORGE_COMMAND_TIMEOUT_MS,
    });
    const lines = stdout.split("\n");
    for (const line of lines) {
      const normalized = line.trim();
      if (!normalized || !normalized.includes("=")) continue;
      const [key, value] = normalized.split("=");
      if (key.trim().toLowerCase() === "updated_at") {
        const parsed = Date.parse(value.trim());
        if (!Number.isNaN(parsed)) {
          return { updatedAt: new Date(parsed) };
        }
      }
      if (key.trim().toLowerCase() === "updated-at") {
        const parsed = Date.parse(value.trim());
        if (!Number.isNaN(parsed)) {
          return { updatedAt: new Date(parsed) };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildRestoreModelSuffix(model: string | undefined): string {
  if (!model || typeof model !== "string") return "";
  return ` --model ${renderForgeModelForShell(model)}`;
}

function classifyForgeTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (/\(Y\)es.*\(N\)o/i.test(lastLine)) return "waiting_input";
  if (/approval required/i.test(lastLine)) return "waiting_input";
  if (/Do you want to proceed\?/i.test(lastLine)) return "waiting_input";
  if (/Allow .+\?/i.test(lastLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: "forge",
  slot: "agent" as const,
  description: "Agent plugin: Forge",
  version: "0.1.0",
  displayName: "Forge",
};

function createForgeAgent(): Agent {
  return {
    name: "forge",
    processName: "forge",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const conversationId = asValidForgeSessionId(
        (config.projectConfig.agentConfig as ForgeAgentConfig | undefined)?.forgeConversationId,
      );
      if (!conversationId) {
        return "forge";
      }
      return `forge --conversation-id ${shellEscape(conversationId)}`;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;
      env["FORGE_DUMP_AUTO_OPEN"] = "false";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyForgeTerminalOutput(terminalOutput);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      let activityResult: Awaited<ReturnType<typeof readLastActivityEntry>> = null;
      if (session.workspacePath) {
        activityResult = await readLastActivityEntry(session.workspacePath);
        const activityState = checkActivityLogState(activityResult);
        if (activityState) return activityState;
      }

      const conversationId = asValidForgeSessionId(session.metadata?.forgeConversationId);
      if (conversationId) {
        const stats = await fetchForgeConversationStats(conversationId);
        if (stats?.updatedAt) {
          const ageMs = Math.max(0, Date.now() - stats.updatedAt.getTime());
          if (ageMs <= activeWindowMs) return { state: "active", timestamp: stats.updatedAt };
          if (ageMs <= threshold) return { state: "ready", timestamp: stats.updatedAt };
          return { state: "idle", timestamp: stats.updatedAt };
        }
      }

      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output: string) =>
        classifyForgeTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)forge(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM") {
              return true;
            }
            return false;
          }
        }
        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const conversationId = asValidForgeSessionId(session.metadata?.forgeConversationId);
      if (!conversationId) return null;
      const { summary, summaryIsFallback } = await fetchForgeConversationSummary(conversationId);
      return {
        agentSessionId: conversationId,
        summary: summary ?? null,
        summaryIsFallback: summary ? summaryIsFallback : undefined,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      const conversationId = asValidForgeSessionId(session.metadata?.forgeConversationId);
      if (!conversationId) return null;
      const sessionModel = session.metadata?.forgeModel;
      const projectModel = (project.agentConfig as ForgeAgentConfig | undefined)?.model;
      const modelSuffix = buildRestoreModelSuffix(sessionModel ?? projectModel);
      return `forge --conversation-id ${shellEscape(conversationId)}${modelSuffix}`;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);

      if (!session.metadata) return;
      const model = session.metadata["forgeModel"]?.trim();
      if (!model) return;

      let provider: string;
      let configuredModel: string;
      try {
        [provider, configuredModel] = parseForgeModelArgs(model);
      } catch {
        throw new Error(
          `Invalid Forge model format: "${model}". Use "<provider> <model>" or "<provider>/<model>".`,
        );
      }

      await runForgeCommand(["config", "set", "model", provider, configuredModel], {
        cwd: session.workspacePath,
        timeout: FORGE_COMMAND_TIMEOUT_MS,
      });
    },
  };
}

export function create(): Agent {
  return createForgeAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("forge"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
