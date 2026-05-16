import { describe, expect, it } from "bun:test";
import { killStaleTeamroomContainers, type DockerExec } from "../../src/container/kill-stale.js";

describe("daemon-restart-kills-containers", () => {
  it("lists by the teamroom-agent label and kills every matching id", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: DockerExec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "ps") return { stdout: "stale-1\nstale-2\nstale-3\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const killed = await killStaleTeamroomContainers({ dockerExec: exec });

    expect(killed).toEqual(["stale-1", "stale-2", "stale-3"]);
    // Exactly one filtered `docker ps`, plus one `docker kill` per id.
    expect(calls[0]!.args).toEqual(["ps", "-q", "--filter", "label=teamroom-agent=true"]);
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      ["kill", "stale-1"],
      ["kill", "stale-2"],
      ["kill", "stale-3"],
    ]);
  });

  it("is a no-op when no stale containers match the label", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: DockerExec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "" };
    };
    const killed = await killStaleTeamroomContainers({ dockerExec: exec });
    expect(killed).toEqual([]);
    expect(calls).toEqual([
      { cmd: "docker", args: ["ps", "-q", "--filter", "label=teamroom-agent=true"] },
    ]);
  });
});
