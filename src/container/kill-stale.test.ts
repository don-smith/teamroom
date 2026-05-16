import { describe, expect, it, vi } from "bun:test";
import { killStaleTeamroomContainers, type DockerExec } from "./kill-stale.js";

describe("killStaleTeamroomContainers", () => {
  it("lists by teamroom-agent label and kills each id", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: DockerExec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "ps") return { stdout: "abc\ndef\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const killed = await killStaleTeamroomContainers({ dockerExec: exec });
    expect(killed).toEqual(["abc", "def"]);
    expect(calls).toEqual([
      { cmd: "docker", args: ["ps", "-q", "--filter", "label=teamroom-agent=true"] },
      { cmd: "docker", args: ["kill", "abc"] },
      { cmd: "docker", args: ["kill", "def"] },
    ]);
  });

  it("returns [] when no stale containers are present", async () => {
    const exec: DockerExec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    expect(await killStaleTeamroomContainers({ dockerExec: exec })).toEqual([]);
  });

  it("continues when a kill fails — best-effort", async () => {
    const exec: DockerExec = async (_cmd, args) => {
      if (args[0] === "ps") return { stdout: "id1\nid2\n", stderr: "" };
      if (args[1] === "id1") throw new Error("no such container");
      return { stdout: "", stderr: "" };
    };
    const killed = await killStaleTeamroomContainers({ dockerExec: exec });
    expect(killed).toEqual(["id2"]);
  });

  it("logs and returns [] when docker ps itself fails", async () => {
    const exec: DockerExec = async () => {
      throw new Error("docker daemon not running");
    };
    const killed = await killStaleTeamroomContainers({ dockerExec: exec });
    expect(killed).toEqual([]);
  });

  it("honors a custom docker binary path", async () => {
    const seen: string[] = [];
    const exec: DockerExec = async (cmd) => {
      seen.push(cmd);
      return { stdout: "", stderr: "" };
    };
    await killStaleTeamroomContainers({ dockerExec: exec, dockerBinary: "/opt/docker" });
    expect(seen).toEqual(["/opt/docker"]);
  });
});
