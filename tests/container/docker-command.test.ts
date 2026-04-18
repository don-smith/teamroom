import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../../src/container/docker-command.js";

describe("buildDockerRunArgs", () => {
  it("produces the expected argv for a standard turn", () => {
    const argv = buildDockerRunArgs({
      imageTag: "teamroom-agent-assistant:latest",
      mounts: [
        { hostPath: "/abs/agents/assistant/AGENTS.md", containerPath: "/AGENTS.md", readOnly: true },
        { hostPath: "/abs/agents/assistant/store", containerPath: "/store", readOnly: false },
      ],
      env: {
        TEAMROOM_TRACE_ID: "trace-1",
        TEAMROOM_TURN_ID: "turn-1",
        TEAMROOM_AGENT_NAME: "assistant",
        ANTHROPIC_API_KEY: "sk-x",
      },
    });

    expect(argv).toEqual([
      "run", "--rm", "-i",
      "-v", "/abs/agents/assistant/AGENTS.md:/AGENTS.md:ro",
      "-v", "/abs/agents/assistant/store:/store",
      "-e", "ANTHROPIC_API_KEY=sk-x",
      "-e", "TEAMROOM_AGENT_NAME=assistant",
      "-e", "TEAMROOM_TRACE_ID=trace-1",
      "-e", "TEAMROOM_TURN_ID=turn-1",
      "teamroom-agent-assistant:latest",
    ]);
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
