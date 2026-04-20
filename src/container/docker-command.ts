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
  /**
   * Optional docker labels applied with `--label <k>=<v>`. M4 uses these
   * to identify teamroom-owned containers on daemon startup so stale
   * ones can be killed without touching unrelated containers.
   */
  labels?: Record<string, string>;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const args: string[] = ["run", "--rm", "-i"];
  if (spec.name) args.push("--name", spec.name);
  if (spec.labels) {
    const labelKeys = Object.keys(spec.labels).sort();
    for (const key of labelKeys) {
      args.push("--label", `${key}=${spec.labels[key]}`);
    }
  }
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
