// Locale-independent scheduled task state probing via the Windows Task Scheduler
// COM API. schtasks' text output is locale-dependent, but the scheduler's numeric
// task state is not, so this probe is the reliable source for READY/DISABLED.
import { spawnSync } from "node:child_process";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";

type ScheduledTaskStateProbe =
  | { status: "found"; state: number | null }
  | { status: "missing" }
  | { status: "unknown" };

function probeScheduledTaskState(taskName: string): ScheduledTaskStateProbe {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $task=$service.GetFolder('\\').GetTask($taskName); [Console]::Out.Write([int]$task.State); exit 0 } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; [Console]::Out.Write($exception.HResult); exit 1 }",
  ].join("; ");
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (probe.error) {
    return { status: "unknown" };
  }
  if (probe.status === 0) {
    const rawState = probe.stdout.trim();
    const state = /^\d+$/.test(rawState) ? Number.parseInt(rawState, 10) : null;
    return {
      status: "found",
      state,
    };
  }
  const hresult = Number.parseInt(probe.stdout.trim(), 10);
  // Only the locale-independent missing task/folder HRESULT values prove absence.
  return hresult === -2147024894 || hresult === -2147024893
    ? { status: "missing" }
    : { status: "unknown" };
}

export function probeScheduledTaskExists(taskName: string): boolean | null {
  const probe = probeScheduledTaskState(taskName);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}

export function isScheduledTaskDefinitelyNotRunning(taskName: string): boolean {
  const probe = probeScheduledTaskState(taskName);
  if (probe.status !== "found") {
    return false;
  }
  // TASK_STATE_DISABLED and TASK_STATE_READY both prove no instance is queued or running.
  return probe.state === 1 || probe.state === 3;
}
