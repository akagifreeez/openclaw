import type { InstallationTarget } from "../infra/installation-target-context.js";

/** Keep POSIX diagnostic handoffs bound to the installation they inspected. */
export function formatInstallationTargetCommand(
  command: string,
  target: InstallationTarget,
): string {
  const selectors = [
    ["OPENCLAW_STATE_DIR", target.stateDir],
    ["OPENCLAW_CONFIG_PATH", target.configPath],
    ["OPENCLAW_WORKSPACE_DIR", target.defaultWorkspaceDir],
  ] as const;
  const prefix = selectors
    .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return `env ${prefix} ${command}`;
}
