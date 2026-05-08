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
  type CostEstimate,
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
import { createRequire } from "node:module";
import { promisify } from "node:util";
import which from "which";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string; description: string };
const PACKAGE_NAME_PREFIX = "@aoagents/ao-plugin-agent-";
const pluginName = packageJson.name.startsWith(PACKAGE_NAME_PREFIX)
  ? packageJson.name.slice(PACKAGE_NAME_PREFIX.length)
  : packageJson.name;

const execFileAsync = promisify(execFile);
const FORGE_COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_FETCH_TIMEOUT_MS = 2_000;
const MODELS_DEV_CACHE_TTL_MS = 60 * 60 * 1_000;
const MODELS_DEV_DEFAULT_PROVIDER = "opencode";

interface ForgeConversationInfo {
  title: string | null;
  tasks: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

interface ModelsDevPricing {
  input?: number;
  output?: number;
  cache_read?: number;
}

interface ModelsDevModel {
  cost?: ModelsDevPricing;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

let modelsDevCache: { data?: ModelsDevCatalog; expiresAt: number; promise?: Promise<ModelsDevCatalog | null> } | null =
  null;

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
    let bufferExceeded = false;
    const timeoutMs = options.timeout ?? FORGE_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (bufferExceeded) return;
      stdout += chunk;
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (bufferExceeded) return;
      stderr += chunk;
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        child.kill("SIGTERM");
      }
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
      if (bufferExceeded) {
        reject(new Error(`Output exceeded ${MAX_BUFFER_BYTES} bytes: ${commandLabel}`));
        return;
      }
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

function parseTokenCount(raw: string): number | null {
  const normalized = raw.replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseForgeConversationInfo(text: string): ForgeConversationInfo | null {
  let title: string | null = null;
  let tasks: string | null = null;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let currentField: "tasks" | null = null;
  let sawField = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      currentField = null;
      continue;
    }

    const titleMatch = trimmed.match(/^title\s+(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1]?.trim() ?? null;
      currentField = null;
      sawField = true;
      continue;
    }

    const tasksMatch = trimmed.match(/^tasks\s+(.+)$/i);
    if (tasksMatch) {
      tasks = tasksMatch[1]?.trim() ?? null;
      currentField = "tasks";
      sawField = true;
      continue;
    }

    const inputMatch = trimmed.match(/^input tokens\s+([0-9,]+)$/i);
    if (inputMatch) {
      inputTokens = parseTokenCount(inputMatch[1] ?? "") ?? 0;
      currentField = null;
      sawField = true;
      continue;
    }

    const cachedMatch = trimmed.match(/^cached tokens\s+([0-9,]+)/i);
    if (cachedMatch) {
      cachedTokens = parseTokenCount(cachedMatch[1] ?? "") ?? 0;
      currentField = null;
      sawField = true;
      continue;
    }

    const outputMatch = trimmed.match(/^output tokens\s+([0-9,]+)$/i);
    if (outputMatch) {
      outputTokens = parseTokenCount(outputMatch[1] ?? "") ?? 0;
      currentField = null;
      sawField = true;
      continue;
    }

    if (
      currentField === "tasks" &&
      rawLine.startsWith("  ") &&
      !/^[A-Z][A-Z ]+$/.test(trimmed) &&
      !/^(?:id|title|tasks|input tokens|cached tokens|output tokens)\b/i.test(trimmed)
    ) {
      tasks = [tasks, trimmed].filter(Boolean).join(" ");
    }
  }

  if (!sawField) return null;

  return {
    title,
    tasks,
    inputTokens,
    cachedTokens,
    outputTokens,
  };
}

async function fetchForgeConversationInfo(conversationId: string): Promise<ForgeConversationInfo | null> {
  try {
    const { stdout } = await runForgeCommand(["conversation", "info", conversationId], {
      timeout: FORGE_COMMAND_TIMEOUT_MS,
    });
    return parseForgeConversationInfo(stdout);
  } catch {
    return null;
  }
}

function parseForgeModelReference(raw: unknown): { providerId?: string; modelId: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
    return {
      providerId: trimmed.slice(0, slashIdx).trim().toLowerCase(),
      modelId: trimmed.slice(slashIdx + 1).trim(),
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return {
      providerId: parts[0]?.trim().toLowerCase(),
      modelId: parts.slice(1).join(" ").trim(),
    };
  }

  return { modelId: trimmed };
}

function resolveModelsDevProviderCandidates(providerId: string | undefined): string[] {
  const candidates = new Set<string>();
  if (providerId) {
    const normalized = providerId.trim().toLowerCase();
    const aliasMap: Record<string, string[]> = {
      alibaba_coding: ["alibaba-coding-plan", "alibaba"],
      anthropic: ["anthropic"],
      azure: ["azure"],
      bedrock: ["amazon-bedrock"],
      big_model: ["zai"],
      cerebras: ["cerebras"],
      codex: ["opencode", "openai"],
      deepseek: ["deepseek"],
      forge_services: ["opencode"],
      github_copilot: ["github-copilot"],
      google_ai_studio: ["google"],
      open_router: ["openrouter"],
      zai_coding: ["zai"],
    };
    for (const alias of aliasMap[normalized] ?? []) {
      candidates.add(alias);
    }
    candidates.add(normalized.replaceAll("_", "-"));
    candidates.add(normalized.replaceAll("_", ""));
  }
  candidates.add(MODELS_DEV_DEFAULT_PROVIDER);
  return [...candidates];
}

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
  const now = Date.now();
  if (modelsDevCache) {
    if (modelsDevCache.promise) {
      return await modelsDevCache.promise;
    }
    if (now < modelsDevCache.expiresAt && modelsDevCache.data) {
      return modelsDevCache.data;
    }
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(MODELS_DEV_API_URL, { signal: controller.signal });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === "object" ? (data as ModelsDevCatalog) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  modelsDevCache = { expiresAt: now + MODELS_DEV_CACHE_TTL_MS, promise };
  const data = await promise;
  modelsDevCache = data ? { data, expiresAt: Date.now() + MODELS_DEV_CACHE_TTL_MS } : null;
  return data;
}

function findModelsDevPricing(
  catalog: ModelsDevCatalog,
  modelId: string,
  providerHint?: string,
): ModelsDevPricing | null {
  for (const providerKey of resolveModelsDevProviderCandidates(providerHint)) {
    const pricing = catalog[providerKey]?.models?.[modelId]?.cost;
    if (pricing) return pricing;
  }

  let fallback: ModelsDevPricing | null = null;
  for (const provider of Object.values(catalog)) {
    const pricing = provider.models?.[modelId]?.cost;
    if (!pricing) continue;
    if (fallback) return null;
    fallback = pricing;
  }

  return fallback;
}

async function estimateForgeConversationCost(
  modelRefRaw: unknown,
  info: ForgeConversationInfo | null,
): Promise<CostEstimate | undefined> {
  if (!info) return undefined;
  if (info.inputTokens === 0 && info.outputTokens === 0) return undefined;

  const modelRef = parseForgeModelReference(modelRefRaw);
  if (!modelRef) return undefined;

  const catalog = await fetchModelsDevCatalog();
  if (!catalog) return undefined;

  const pricing = findModelsDevPricing(catalog, modelRef.modelId, modelRef.providerId);
  if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") {
    return undefined;
  }

  const cachedTokens = Math.max(0, Math.min(info.cachedTokens, info.inputTokens));
  const uncachedInputTokens = Math.max(0, info.inputTokens - cachedTokens);
  const cacheReadRate = pricing.cache_read ?? pricing.input;
  const estimatedCostUsd =
    (uncachedInputTokens / 1_000_000) * pricing.input +
    (cachedTokens / 1_000_000) * cacheReadRate +
    (info.outputTokens / 1_000_000) * pricing.output;

  return {
    inputTokens: info.inputTokens,
    outputTokens: info.outputTokens,
    estimatedCostUsd,
  };
}

export function resetModelsDevCache(): void {
  modelsDevCache = null;
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, "g");
const FORGE_CONTINUE_PROMPT_RE = /^(?:\?\s*)?Do you want to continue anyway\?\s*[Yy]\/[Nn]:\s*$/;

function classifyForgeTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (FORGE_CONTINUE_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Forge",
};

function createForgeAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
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
      const conversationInfo = await fetchForgeConversationInfo(conversationId);
      const summary = conversationInfo?.title ?? null;
      const cost = await estimateForgeConversationCost(session.metadata?.forgeModel, conversationInfo);
      return {
        agentSessionId: conversationId,
        summary: summary ?? null,
        summaryIsFallback: summary ? false : undefined,
        ...(cost ? { cost } : {}),
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const conversationId = asValidForgeSessionId(session.metadata?.forgeConversationId);
      if (!conversationId) return null;
      return `forge --conversation-id ${shellEscape(conversationId)}`;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
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
