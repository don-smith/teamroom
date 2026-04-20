import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../logger/logger.js";

const execFile = promisify(execFileCb);

/**
 * Shape that maps `docker` command invocations to their stdout. Injected
 * so tests can drive the behavior without requiring Docker — production
 * passes in the real child_process-backed exec.
 */
export interface DockerExec {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export const realDockerExec: DockerExec = async (cmd, args) => {
  const { stdout, stderr } = await execFile(cmd, args, { encoding: "utf8" });
  return { stdout, stderr };
};

/**
 * Kill every docker container labeled `teamroom-agent=true`. Called once
 * at daemon startup — mid-turn state is non-resumable across a daemon
 * restart (mail persistence is in the DB, not in the live container), so
 * the clean-slate approach matches the NanoClaw precedent referenced in
 * docs/memory/project_teamroom_nanoclaw_reference.md.
 *
 * Best-effort per container — a container that races the kill and exits
 * on its own is fine.
 */
export async function killStaleTeamroomContainers(opts: {
  dockerExec?: DockerExec;
  dockerBinary?: string;
  logger?: Logger;
}): Promise<string[]> {
  const exec = opts.dockerExec ?? realDockerExec;
  const binary = opts.dockerBinary ?? "docker";
  const killed: string[] = [];
  let listOut: string;
  try {
    const { stdout } = await exec(binary, [
      "ps",
      "-q",
      "--filter",
      "label=teamroom-agent=true",
    ]);
    listOut = stdout;
  } catch (err) {
    opts.logger?.warn("kill-stale.list-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return killed;
  }
  const ids = listOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    try {
      await exec(binary, ["kill", id]);
      killed.push(id);
    } catch (err) {
      opts.logger?.warn("kill-stale.kill-failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return killed;
}
