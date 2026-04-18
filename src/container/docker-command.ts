export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface DockerRunSpec {
  imageTag: string;
  mounts: Mount[];
  env: Record<string, string>;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const args: string[] = ["run", "--rm", "-i"];
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
