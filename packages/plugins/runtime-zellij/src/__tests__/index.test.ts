import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@aoagents/ao-core";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
}));

const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const expectedZellijOptions = expect.objectContaining({ timeout: 5_000, windowsHide: true });

function mockZellijSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout, stderr: "" });
}

function mockZellijError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function makeHandle(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    id: "test-session",
    runtimeName: "zellij",
    data: {
      createdAt: 1000,
      workspacePath: "/tmp/workspace",
      paneId: "7",
      socketDir: "/tmp/aoz-test",
    },
    ...overrides,
  };
}

import zellijPlugin, { create, manifest } from "../index.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("manifest", () => {
  it("has name 'zellij' and slot 'runtime'", () => {
    expect(manifest.name).toBe("zellij");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Zellij sessions");
  });

  it("default export includes manifest and create", () => {
    expect(zellijPlugin.manifest).toBe(manifest);
    expect(zellijPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'zellij'", () => {
    const runtime = create();
    expect(runtime.name).toBe("zellij");
  });
});

describe("runtime.create()", () => {
  it("creates a named background Zellij session from a layout string", async () => {
    const runtime = create();
    mockZellijSuccess();
    mockZellijSuccess('[{"id":3,"is_plugin":false}]');

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: { AO_SESSION: "test-session" },
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("zellij");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");
    expect(handle.data.paneId).toBe("3");
    expect(handle.data.socketDir).toMatch(/^\/tmp\/aoz/);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-zellij-launch-test-uuid-1234.sh"),
      expect.stringMatching(/echo hello\nexec "\$\{SHELL:-\/bin\/bash\}" -i/),
      { encoding: "utf-8", mode: 0o700 },
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "zellij",
      [
        "--layout-string",
        expect.stringContaining('pane command="bash"'),
        "attach",
        "--create-background",
        "test-session",
      ],
      expect.objectContaining({
        cwd: "/tmp/workspace",
        env: expect.objectContaining({ AO_SESSION: "test-session" }),
        timeout: 5_000,
        windowsHide: true,
      }),
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["--session", "test-session", "action", "list-panes", "--json", "--all"],
      expectedZellijOptions,
    );
  });

  it("removes inherited ZELLIJ environment variables from control commands", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_PANE_ID = "1";
    process.env.ZELLIJ_SESSION_NAME = "parent";
    const runtime = create();
    mockZellijSuccess();
    mockZellijSuccess('[{"id":0,"is_plugin":false}]');

    await runtime.create({
      sessionId: "nested-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: {},
    });

    const options = mockExecFileCustom.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.ZELLIJ).toBeUndefined();
    expect(options.env.ZELLIJ_PANE_ID).toBeUndefined();
    expect(options.env.ZELLIJ_SESSION_NAME).toBeUndefined();
  });

  it("rejects unsafe session IDs", async () => {
    const runtime = create();
    await expect(
      runtime.create({
        sessionId: "bad;session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo hello",
        environment: {},
      }),
    ).rejects.toThrow("Invalid session ID");
    expect(mockExecFileCustom).not.toHaveBeenCalled();
  });

  it("cleans up if Zellij session creation fails", async () => {
    const runtime = create();
    mockZellijError("layout failed");
    mockZellijSuccess();

    await expect(
      runtime.create({
        sessionId: "cleanup-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "echo hello",
        environment: {},
      }),
    ).rejects.toThrow('Failed to launch Zellij session "cleanup-session"');

    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("ao-zellij-launch"));
    expect(mockExecFileCustom).toHaveBeenLastCalledWith(
      "zellij",
      ["kill-session", "cleanup-session"],
      expectedZellijOptions,
    );
  });
});

describe("runtime.destroy()", () => {
  it("kills the Zellij session", async () => {
    const runtime = create();
    mockZellijSuccess();

    await runtime.destroy(makeHandle({ id: "dead-session" }));

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "dead-session"],
      expectedZellijOptions,
    );
  });

  it("ignores missing sessions", async () => {
    const runtime = create();
    mockZellijError("not found");

    await expect(runtime.destroy(makeHandle())).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("clears input, pastes text, and presses Enter", async () => {
    const runtime = create();
    mockZellijSuccess();
    mockZellijSuccess();
    mockZellijSuccess();

    await runtime.sendMessage(makeHandle(), "hello world");

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["--session", "test-session", "action", "send-keys", "--pane-id", "7", "Ctrl u"],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["--session", "test-session", "action", "paste", "--pane-id", "7", "hello world"],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "zellij",
      ["--session", "test-session", "action", "send-keys", "--pane-id", "7", "Enter"],
      expectedZellijOptions,
    );
  });
});

describe("runtime.getOutput()", () => {
  it("dumps the Zellij pane screen and tails requested lines", async () => {
    const runtime = create();
    mockZellijSuccess("one\ntwo\nthree\nfour");

    await expect(runtime.getOutput(makeHandle(), 2)).resolves.toBe("three\nfour");
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["--session", "test-session", "action", "dump-screen", "--full", "--pane-id", "7"],
      expectedZellijOptions,
    );
  });

  it("returns empty output when dump-screen fails", async () => {
    const runtime = create();
    mockZellijError("gone");

    await expect(runtime.getOutput(makeHandle())).resolves.toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true for active sessions", async () => {
    const runtime = create();
    mockZellijSuccess("other [Created 1s ago]\ntest-session [Created 1s ago] ");

    await expect(runtime.isAlive(makeHandle())).resolves.toBe(true);
  });

  it("returns false for exited resurrectable sessions", async () => {
    const runtime = create();
    mockZellijSuccess("test-session [Created 1s ago] (EXITED - attach to resurrect)");

    await expect(runtime.isAlive(makeHandle())).resolves.toBe(false);
  });

  it("returns false when list-sessions fails", async () => {
    const runtime = create();
    mockZellijError("not running");

    await expect(runtime.isAlive(makeHandle())).resolves.toBe(false);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns a zellij attach command", async () => {
    const runtime = create();

    await expect(runtime.getAttachInfo!(makeHandle())).resolves.toEqual({
      type: "zellij",
      target: "test-session",
      command: "ZELLIJ_SOCKET_DIR='/tmp/aoz-test' zellij attach 'test-session'",
    });
  });
});
