import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@aoagents/ao-core";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { constants as OS_CONSTANTS } from "node:os";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string; description: string };
const PACKAGE_NAME_PREFIX = "@aoagents/ao-plugin-agent-";
const pluginName = packageJson.name.startsWith(PACKAGE_NAME_PREFIX)
  ? packageJson.name.slice(PACKAGE_NAME_PREFIX.length)
  : packageJson.name;
const SIGTERM_SIGNAL = OS_CONSTANTS.signals.SIGTERM;

const {
  mockReadLastActivityEntry,
  mockRecordTerminalActivity,
  mockSetupPathWrapperWorkspace,
  mockExecFileAsync,
  mockSpawnAsync,
  mockFetch,
  mockWhichSync,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockSpawnAsync: vi.fn(),
  mockFetch: vi.fn(),
  mockWhichSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    setupPathWrapperWorkspace: mockSetupPathWrapperWorkspace,
  };
});

vi.mock("which", () => ({
  default: {
    sync: mockWhichSync,
  },
  sync: mockWhichSync,
}));

vi.stubGlobal("fetch", mockFetch);

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1];
    const result = mockExecFileAsync(...args.slice(0, -1));
    if (typeof callback === "function" && result && typeof result.then === "function") {
      result.then(
        (value: { stdout: string; stderr: string }) => callback(null, value),
        (err: Error) => callback(err),
      );
    }
  },
  spawn: (...args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();

    const result = mockSpawnAsync(...args);
    if (result && typeof result.then === "function") {
      result.then(
        (value: { stdout: string; stderr: string }) => {
          queueMicrotask(() => {
            if (value.stdout) child.stdout.write(value.stdout);
            child.stdout.end();
            if (value.stderr) child.stderr.write(value.stderr);
            child.stderr.end();
            child.emit("close", 0, null);
          });
        },
        (err: Error & { stdout?: string; stderr?: string; code?: number; signal?: NodeJS.Signals }) => {
          queueMicrotask(() => {
            if (err.stdout) child.stdout.write(err.stdout);
            child.stdout.end();
            if (err.stderr) child.stderr.write(err.stderr);
            child.stderr.end();
            child.emit("close", err.code ?? 1, err.signal ?? null);
          });
        },
      );
    }

    return child;
  },
  execFileSync: vi.fn(),
}));

import { create, detect, manifest, resetModelsDevCache, default as defaultExport } from "./index.js";

const VALID_FORGE_CONVERSATION_ID = "53f35f67-e699-4391-96c8-598eee67e67d";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number | string): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: {
        model: "provider/gpt-4o-mini",
      },
    },
    ...overrides,
  };
}

function makeActivityResult(
  state: "active" | "ready" | "idle" | "waiting_input" | "blocked",
  ts: Date,
): {
  entry: {
    state: "active" | "ready" | "idle" | "waiting_input" | "blocked";
    ts: string;
    source: string;
  };
  modifiedAt: Date;
} {
  return {
    entry: {
      state,
      ts: ts.toISOString(),
      source: "terminal",
    },
    modifiedAt: ts,
  };
}

function makeForgeConversationInfoOutput({
  title = "Terminate All Orchestrator Sessions",
  tasks = "use `packages/ao/bin/ao.js status` cmd and kill all of them orchestrator session running real quick.",
  inputTokens = 1_000,
  cachedTokens = 200,
  outputTokens = 50,
}: {
  title?: string;
  tasks?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
} = {}): string {
  const cachedPct = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0;
  return [
    "CONVERSATION",
    `  id    ${VALID_FORGE_CONVERSATION_ID}`,
    `  title ${title}`,
    `  tasks ${tasks}`,
    "",
    "TOKEN USAGE",
    `  input tokens  ${inputTokens.toLocaleString("en-US")}`,
    `  cached tokens ${cachedTokens.toLocaleString("en-US")} [${cachedPct}%]`,
    `  output tokens ${outputTokens.toLocaleString("en-US")}`,
  ].join("\n");
}

function makeModelsDevCatalog(): unknown {
  return {
    opencode: {
      models: {
        "gpt-5.4": {
          cost: {
            input: 2.5,
            output: 15,
            cache_read: 0.25,
          },
        },
      },
    },
    zai: {
      models: {
        "glm-5.1": {
          cost: {
            input: 1.4,
            output: 4.4,
            cache_read: 0.26,
          },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockSpawnAsync.mockReset();
  mockFetch.mockReset();
  resetModelsDevCache();
});

describe("manifest", () => {
  it("has correct Forge manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Forge",
    });
  });
});

describe("create", () => {
  it("uses forge as process name and post-launch prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", async () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/forge");
    expect(detect()).toBe(true);
  });

  it("returns false when which fails", async () => {
    mockWhichSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("uses interactive launch without session id", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("forge");
  });

  it("uses --conversation-id when configured", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
        },
      }),
    );
    expect(cmd).toBe(`forge --conversation-id '${VALID_FORGE_CONVERSATION_ID}'`);
  });

  it("does not include prompt flags in launch command", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toBe("forge");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--prompt");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and forge flags", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["FORGE_DUMP_AUTO_OPEN"]).toBe("false");
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when forge is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  forge -c\n`,
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when tmux process missing", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({ stdout: "  PID TT      ARGS\n  789 ttys003  bash\n", stderr: "" });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });
});

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "foo\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "foo\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as ((output: string) => string) | undefined;
    expect(classify?.("foo\n> ")).toBe("idle");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "[17:09:11] Maximum tool failure limit (3) reached for this turn\n? Do you want to continue anyway? y/N:",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as ((output: string) => string) | undefined;
    expect(
      classify?.(
        "[17:09:11] Maximum tool failure limit (3) reached for this turn\n? Do you want to continue anyway? y/N:",
      ),
    ).toBe("waiting_input");
  });

  it("classifies ansi-colored forge continue prompts as waiting_input", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "\u001b[33m?\u001b[39m Do you want to continue anyway? y/N:",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as ((output: string) => string) | undefined;
    expect(classify?.("\u001b[33m?\u001b[39m Do you want to continue anyway? y/N:")).toBe(
      "waiting_input",
    );
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without conversation id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("uses the conversation title as the summary and includes cost", async () => {
    mockSpawnAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "conversation" && args[1] === "info") {
        return Promise.resolve({
          stdout: makeForgeConversationInfoOutput(),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeModelsDevCatalog(),
    });
    const info = await agent.getSessionInfo(
      makeSession({
        metadata: {
          forgeConversationId: VALID_FORGE_CONVERSATION_ID,
          forgeModel: "gpt-5.4",
        },
      }),
    );
    expect(info?.summary).toBe("Terminate All Orchestrator Sessions");
    expect(info?.summaryIsFallback).toBe(false);
    expect(info?.agentSessionId).toBe(VALID_FORGE_CONVERSATION_ID);
    expect(info?.cost?.inputTokens).toBe(1_000);
    expect(info?.cost?.outputTokens).toBe(50);
    expect(info?.cost?.estimatedCostUsd).toBeCloseTo(0.0028, 6);
  });

  it("uses conversation info title and models.dev pricing for non-codex providers", async () => {
    mockSpawnAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "conversation" && args[1] === "info") {
        return Promise.resolve({
          stdout: makeForgeConversationInfoOutput({
            inputTokens: 500,
            cachedTokens: 100,
            outputTokens: 20,
          }),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeModelsDevCatalog(),
    });
    const info = await agent.getSessionInfo(
      makeSession({
        metadata: {
          forgeConversationId: VALID_FORGE_CONVERSATION_ID,
          forgeModel: "zai_coding/glm-5.1",
        },
      }),
    );
    expect(info?.summary).toBe("Terminate All Orchestrator Sessions");
    expect(info?.summaryIsFallback).toBe(false);
    expect(info?.cost?.inputTokens).toBe(500);
    expect(info?.cost?.outputTokens).toBe(20);
    expect(info?.cost?.estimatedCostUsd).toBeCloseTo(0.000674, 6);
  });

  it("treats forge conversation info lookup as unavailable when command closes with SIGTERM", async () => {
    mockSpawnAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "conversation" && args[1] === "info") {
        return Promise.reject(
          Object.assign(new Error("terminated"), {
            code: 1,
            signal: SIGTERM_SIGNAL,
            stdout: "",
            stderr: "",
          }),
        );
      }
      return Promise.reject(new Error("unexpected"));
    });
    const info = await agent.getSessionInfo(
      makeSession({
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(info).toMatchObject({
      agentSessionId: VALID_FORGE_CONVERSATION_ID,
      summary: null,
      summaryIsFallback: undefined,
    });
    expect(info).not.toHaveProperty("cost");
  });

  it("skips cost lookup when no forge model metadata is present", async () => {
    mockSpawnAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "conversation" && args[1] === "info") {
        return Promise.resolve({
          stdout: makeForgeConversationInfoOutput(),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID } }),
    );
    expect(info?.summary).toBe("Terminate All Orchestrator Sessions");
    expect(info?.summaryIsFallback).toBe(false);
    expect(info?.cost).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();
  it("builds restore command using the conversation id only", async () => {
    const cmd = await agent.getRestoreCommand(
      makeSession({ metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: { model: "provider/gpt-4o" },
      },
    );
    expect(cmd).toBe(`forge --conversation-id '${VALID_FORGE_CONVERSATION_ID}'`);
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("only sets up workspace hooks when no metadata model is present", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test", metadata: {} })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it("does not mutate forge config when metadata includes a model", async () => {
    await expect(
      agent.postLaunchSetup?.(
        makeSession({
          workspacePath: "/workspace/test",
          metadata: { forgeModel: "provider/gpt-4o" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it("ignores invalid forge model metadata during post-launch setup", async () => {
    await expect(
      agent.postLaunchSetup?.(
        makeSession({
          workspacePath: "/workspace/test",
          metadata: { forgeModel: "badmodel" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("falls back to exited when runtime handle missing", async () => {
    const state = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(state).toMatchObject({ state: "exited" });
  });

  it("falls back to activity JSONL state", async () => {
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("waiting_input", new Date()));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("waiting_input");
    killSpy.mockRestore();
  });

  it("returns blocked from recent activity JSONL", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("blocked", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("blocked");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns active from JSONL fallback without querying Forge stats", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("active");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    expect(mockSpawnAsync).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("decays JSONL fallback state to idle when the entry is stale", async () => {
    const activityAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    mockSpawnAsync.mockRejectedValue(new Error("native stats unavailable"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("idle");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns null when no native or JSONL activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state).toBeNull();
    expect(mockSpawnAsync).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
