import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "./docker-command.js";

describe("buildDockerRunArgs", () => {
  it("produces the expected argv for a standard turn", () => {
    const argv = buildDockerRunArgs({
      imageTag: "teamroom-agent-studio-assistant:latest",
      mounts: [
        // M2 contract: AGENTS.md is read-write so agents may evolve their own
        // operating doc across turns. See spec §2.
        { hostPath: "/abs/agents/studio-assistant/AGENTS.md", containerPath: "/AGENTS.md", readOnly: false },
        { hostPath: "/abs/agents/studio-assistant/store", containerPath: "/store", readOnly: false },
      ],
      env: {
        TEAMROOM_TRACE_ID: "trace-1",
        TEAMROOM_TURN_ID: "turn-1",
        TEAMROOM_AGENT_NAME: "studio-assistant",
        ANTHROPIC_API_KEY: "sk-x",
      },
    });

    expect(argv).toEqual([
      "run", "--rm", "-i",
      "-v", "/abs/agents/studio-assistant/AGENTS.md:/AGENTS.md",
      "-v", "/abs/agents/studio-assistant/store:/store",
      "-e", "ANTHROPIC_API_KEY=sk-x",
      "-e", "TEAMROOM_AGENT_NAME=studio-assistant",
      "-e", "TEAMROOM_TRACE_ID=trace-1",
      "-e", "TEAMROOM_TURN_ID=turn-1",
      "teamroom-agent-studio-assistant:latest",
    ]);
  });

  it("appends :ro suffix for read-only mounts", () => {
    const argv = buildDockerRunArgs({
      imageTag: "img:latest",
      mounts: [{ hostPath: "/host/ro", containerPath: "/ro", readOnly: true }],
      env: {},
    });
    expect(argv).toContain("/host/ro:/ro:ro");
  });

  it("mounts AGENTS.md as writable (M2 contract regression)", () => {
    // Regression guard for M2 spec §2: AGENTS.md must be writable so agents
    // can evolve their own operating doc across turns. A future change that
    // flips this back to readOnly:true must fail here.
    const argv = buildDockerRunArgs({
      imageTag: "img:latest",
      mounts: [
        { hostPath: "/abs/agents/studio-assistant/AGENTS.md", containerPath: "/AGENTS.md", readOnly: false },
        { hostPath: "/abs/agents/studio-assistant/store", containerPath: "/store", readOnly: false },
      ],
      env: {},
    });
    const agentsMdMount = argv.find((a) => a.includes(":/AGENTS.md"));
    expect(agentsMdMount).toBeDefined();
    expect(agentsMdMount).not.toMatch(/:ro$/);
  });

  it("orders env deterministically (sorted by key)", () => {
    const argv = buildDockerRunArgs({
      imageTag: "img:latest",
      mounts: [],
      env: { B: "2", A: "1" },
    });
    const bIndex = argv.indexOf("A=1");
    const aIndex = argv.indexOf("B=2");
    expect(bIndex).toBeLessThan(aIndex);
  });
});
