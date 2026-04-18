export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface DockerRunSpec {
  imageTag: string;
  mounts: Mount[];
  env: Record<string, string>;
  /**
   * Optional `--name <value>` for the container. When set, `docker ps` /
   * `docker logs` / `docker stop` can target the container by a meaningful
   * identifier instead of Docker's auto-generated friendly name. Must be
   * unique across running containers.
   */
  name?: string;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const args: string[] = ["run", "--rm", "-i"];
  if (spec.name) args.push("--name", spec.name);
  for (const m of spec.mounts) {
    const suffix = m.readOnly ? ":ro" : "";
    args.push("-v", `${m.hostPath}:${m.containerPath}${suffix}`);
  }
  const keys = Object.keys(spec.env).sort();
  for (const key of keys) {
    args.push("-e", `${key}=${spec.env[key]}`);
  }
  args.push(spec.imageTag);
  return args;
}
