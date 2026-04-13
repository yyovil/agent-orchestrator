import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@aoagents/ao-core";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const {
  mockReadLastActivityEntry,
  mockRecordTerminalActivity,
  mockSetupPathWrapperWorkspace,
  mockExecFileAsync,
  mockSpawnAsync,
  mockWhichSync,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockSpawnAsync: vi.fn(),
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

import { create, detect, manifest, default as defaultExport } from "../index.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockSpawnAsync.mockReset();
});

describe("manifest", () => {
  it("has correct Forge manifest", () => {
    expect(manifest).toEqual({
      name: "forge",
      slot: "agent",
      description: "Agent plugin: Forge",
      version: "0.1.0",
      displayName: "Forge",
    });
  });
});

describe("create", () => {
  it("uses forge as process name and post-launch prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe("forge");
    expect(agent.processName).toBe("forge");
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
    await agent.recordActivity?.(makeSession(), "Do you want to proceed? (Y)es/(N)o");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as ((output: string) => string) | undefined;
    expect(classify?.("Do you want to proceed? (Y)es/(N)o")).toBe("waiting_input");
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

  it("prefers the first meaningful line from conversation markdown", async () => {
    mockSpawnAsync.mockResolvedValueOnce({
      stdout: "# Assistant response\nImplemented the fix\n\nMore detail",
      stderr: "",
    });
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID } }),
    );
    expect(info?.summary).toBe("Implemented the fix");
    expect(info?.summaryIsFallback).toBe(false);
    expect(info?.agentSessionId).toBe(VALID_FORGE_CONVERSATION_ID);
  });

  it("falls back to conversation info text", async () => {
    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: "# Assistant response\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "summary=Done all tasks\n", stderr: "" });
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID } }),
    );
    expect(info?.summary).toBe("Done all tasks");
    expect(info?.summaryIsFallback).toBe(true);
  });
});

describe("getRestoreCommand", () => {
  const agent = create();
  it("builds restore command using project model", async () => {
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
    expect(cmd).toBe(
      `forge --conversation-id '${VALID_FORGE_CONVERSATION_ID}' --model 'provider' 'gpt-4o'`,
    );
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("skips model config when no metadata model", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test", metadata: {} })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("runs forge config set model using metadata model", async () => {
    mockSpawnAsync.mockResolvedValue({ stdout: "", stderr: "" });
    const session = makeSession({
      workspacePath: "/workspace/test",
      metadata: { forgeModel: "provider/gpt-4o" },
    });
    await agent.postLaunchSetup?.(session);
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      "forge",
      ["config", "set", "model", "provider", "gpt-4o"],
      expect.objectContaining({ cwd: "/workspace/test", stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("throws for invalid forge model", async () => {
    const session = makeSession({
      workspacePath: "/workspace/test",
      metadata: { forgeModel: "badmodel" },
    });
    await expect(agent.postLaunchSetup?.(session)).rejects.toThrow("Invalid Forge model format");
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

  it("returns active from native Forge conversation stats", async () => {
    const updatedAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(null);
    mockSpawnAsync.mockResolvedValue({
      stdout: `updated-at=${updatedAt.toISOString()}\n`,
      stderr: "",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("active");
    expect(state?.timestamp.toISOString()).toBe(updatedAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns active from JSONL fallback when native signal is unavailable", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    mockSpawnAsync.mockRejectedValue(new Error("native stats unavailable"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { forgeConversationId: VALID_FORGE_CONVERSATION_ID },
      }),
    );
    expect(state?.state).toBe("active");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
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
      }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});
