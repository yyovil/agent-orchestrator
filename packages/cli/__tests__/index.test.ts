import { describe, expect, it, vi } from "vitest";

const parseAsync = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/program.js", () => ({
  createProgram: () => ({ parseAsync }),
}));

describe("cli entrypoint", () => {
  it("parses the created program", async () => {
    await import("../src/index.js");
    expect(parseAsync).toHaveBeenCalledOnce();
  });
});
