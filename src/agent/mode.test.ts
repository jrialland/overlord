import { describe, expect, it } from "bun:test";
import { resolveInitialAgentMode } from "./agent";

describe("resolveInitialAgentMode", () => {
    it("defaults top-level agents to plan mode", () => {
        expect(resolveInitialAgentMode(undefined, false)).toBe("plan");
    });

    it("uses persisted agent mode for top-level sessions", () => {
        expect(resolveInitialAgentMode("agent", false)).toBe("agent");
    });

    it("forces sub-agents to agent mode regardless of persisted mode", () => {
        expect(resolveInitialAgentMode("plan", true)).toBe("agent");
        expect(resolveInitialAgentMode(undefined, true)).toBe("agent");
    });
});
