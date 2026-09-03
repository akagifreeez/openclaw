// Relaunches the gateway through the managed Windows scheduled task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;
// The predecessor gateway process needs time to finish its own log-flush exit;
// treat a still-running task instance as "predecessor" only while that pid is
// alive so the handoff never mistakes its own predecessor for a successor.
const PREDECESSOR_WAIT_LIMIT = 60;
const PREDECESSOR_WAIT_DELAY_SEC = 1;
// Successor readiness: the relaunched gateway binds its health port during
// startup; a successor that never listens within this budget is a failed
// handoff and must fall back instead of silently ending the restart.
const SUCCESSOR_READINESS_PROBE_LIMIT = 90;
const SUCCESSOR_READINESS_PROBE_DELAY_SEC = 2;
const SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS = 2000;

function quotePowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

/**
 * Health endpoint the successor gateway is expected to bind. Only numeric
 * ports and hostnames without shell/PowerShell metacharacters are accepted;
 * anything else disables the readiness probe rather than risking injection
 * into the generated cmd script.
 */
function resolveRestartHealthEndpoint(
  env: NodeJS.ProcessEnv,
): { host: string; port: number } | null {
  const rawPort = env.OPENCLAW_RESTART_HEALTH_PORT?.trim();
  if (!/^\d{1,5}$/.test(rawPort ?? "")) {
    return null;
  }
  const port = Number(rawPort);
  if (port <= 0 || port > 65535) {
    return null;
  }
  const host = (env.OPENCLAW_RESTART_HEALTH_HOST?.trim() || "127.0.0.1").toLowerCase();
  if (!/^[a-z0-9._:-]+$/.test(host)) {
    return null;
  }
  return { host, port };
}

function resolvePredecessorPid(env: NodeJS.ProcessEnv): number | null {
  const raw = env.OPENCLAW_RESTART_PREDECESSOR_PID?.trim();
  if (!/^\d{1,10}$/.test(raw ?? "")) {
    return null;
  }
  const pid = Number(raw);
  return pid > 0 ? pid : null;
}

function buildPredecessorAliveCommand(predecessorPid: number): string {
  return [
    `if (Get-Process -Id ${predecessorPid} -ErrorAction SilentlyContinue) { exit 0 }`,
    "exit 1",
  ].join("; ");
}

function buildSuccessorReadinessCommand(host: string, port: number): string {
  // Deliberately no try/catch: a synchronous BeginConnect failure makes
  // powershell exit non-zero, which the caller reads as "not ready yet".
  return [
    "$c = New-Object Net.Sockets.TcpClient",
    `$a = $c.BeginConnect(${quotePowerShellSingleQuotedLiteral(host)}, ${port}, $null, $null)`,
    `if ($a.AsyncWaitHandle.WaitOne(${SUCCESSOR_READINESS_CONNECT_TIMEOUT_MS}) -and $c.Connected) { exit 0 }`,
    "exit 1",
  ].join("; ");
}

function buildScheduledTaskRestartScript(params: {
  quotedLogPath: string;
  setupLines: string[];
  taskName: string;
  taskScriptPath?: string;
  predecessorPid?: number;
  health?: { host: string; port: number } | null;
}): string {
  const { quotedLogPath, setupLines, taskName, taskScriptPath, predecessorPid, health } = params;
  const quotedTaskName = quoteCmdScriptArg(taskName);
  const queryTaskStateCommand = [
    `$task = Get-ScheduledTask -TaskName ${quotePowerShellSingleQuotedLiteral(taskName)} -ErrorAction SilentlyContinue`,
    "if ($null -ne $task -and $task.State -eq 'Running') { exit 0 }",
    "exit 1",
  ].join("; ");
  const quotedQueryTaskStateCommand = quoteCmdScriptArg(queryTaskStateCommand);
  const quotedPredecessorAliveCommand = predecessorPid
    ? quoteCmdScriptArg(buildPredecessorAliveCommand(predecessorPid))
    : null;
  const quotedReadinessCommand = health
    ? quoteCmdScriptArg(buildSuccessorReadinessCommand(health.host, health.port))
    : null;
  const lines = [
    "@echo off",
    "setlocal",
    ...setupLines,
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart attempt source=windows-task-handoff target=${quotedTaskName}`,
    `schtasks /Query /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto fallback",
  ];
  if (quotedPredecessorAliveCommand) {
    // Wait for this handoff's own predecessor pid to exit before treating a
    // running task instance as a successor started by someone else (#137266).
    lines.push(
      "set /a predwaits=0",
      ":waitpred",
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedPredecessorAliveCommand} >nul 2>&1`,
      "if errorlevel 1 goto starttask",
      `if %predwaits% GEQ ${PREDECESSOR_WAIT_LIMIT} (`,
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart note source=windows-task-handoff predecessor-still-alive-after-wait`,
      ")",
      "goto starttask",
      `timeout /t ${PREDECESSOR_WAIT_DELAY_SEC} /nobreak >nul`,
      "set /a predwaits+=1",
      "goto waitpred",
    );
  }
  lines.push(
    ":starttask",
    "set /a attempts=0",
    ":retry",
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "set /a attempts+=1",
    // After the predecessor exited, a running task instance is a successor
    // started by another restart path; skip straight to readiness probing.
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedQueryTaskStateCommand} >nul 2>&1`,
    "if not errorlevel 1 goto readiness",
    `schtasks /Run /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if not errorlevel 1 goto readiness",
    `if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
    "goto retry",
  );
  if (quotedReadinessCommand) {
    lines.push(
      ":readiness",
      "set /a probes=0",
      ":probe",
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedReadinessCommand} >nul 2>&1`,
      "if not errorlevel 1 goto recovered",
      `if %probes% GEQ ${SUCCESSOR_READINESS_PROBE_LIMIT} goto fallback`,
      `timeout /t ${SUCCESSOR_READINESS_PROBE_DELAY_SEC} /nobreak >nul`,
      "set /a probes+=1",
      "goto probe",
      ":recovered",
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=recovered`,
      "goto cleanup",
    );
  } else {
    lines.push(
      ":readiness",
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=started-unverified`,
      "goto cleanup",
    );
  }
  lines.push(
    ":fallback",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart fallback source=windows-task-handoff`,
  );
  if (taskScriptPath) {
    const quotedScript = quoteCmdScriptArg(taskScriptPath);
    const quotedCmd = quoteCmdScriptArg(getWindowsCmdExePath());
    lines.push(
      `if exist ${quotedScript} (`,
      `  start "" /min ${quotedCmd} /d /c ${quotedScript}`,
      ")",
    );
  }
  if (quotedReadinessCommand) {
    // The direct-launch fallback gets its own bounded readiness pass so a
    // failed handoff leaves a durable outcome instead of a silent outage.
    lines.push(
      "set /a probes=0",
      ":fallbackprobe",
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedReadinessCommand} >nul 2>&1`,
      "if not errorlevel 1 goto recovered",
      `if %probes% GEQ ${SUCCESSOR_READINESS_PROBE_LIMIT} goto handofffailed`,
      `timeout /t ${SUCCESSOR_READINESS_PROBE_DELAY_SEC} /nobreak >nul`,
      "set /a probes+=1",
      "goto fallbackprobe",
      ":handofffailed",
      `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart outcome source=windows-task-handoff result=failed-successor-not-ready`,
    );
  }
  lines.push(
    ":cleanup",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart finished source=windows-task-handoff`,
    'del "%~f0" >nul 2>&1',
  );
  return lines.join("\r\n");
}

export function relaunchGatewayScheduledTask(env: NodeJS.ProcessEnv = process.env): RestartAttempt {
  const taskName = resolveWindowsTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const predecessorPid = resolvePredecessorPid(env);
  const health = resolveRestartHealthEndpoint(env);
  const scriptPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-schtasks-restart-${randomUUID()}.cmd`,
  );
  const quotedScriptPath = quoteCmdScriptArg(scriptPath);
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
  try {
    // The script embeds host paths and the task name; cmd.exe decodes it with
    // the console code page, so plain UTF-8 garbles CJK content (#107416).
    fs.writeFileSync(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: `${buildScheduledTaskRestartScript({
          quotedLogPath: restartLog.quotedLogPath,
          setupLines: restartLog.lines,
          taskName,
          taskScriptPath,
          predecessorPid: predecessorPid ?? undefined,
          health,
        })}\r\n`,
      }),
    );
    const cmdExePath = getWindowsCmdExePath();
    const child = spawn(cmdExePath, ["/d", "/s", "/c", quotedScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      method: "schtasks",
      tried: [`schtasks /Run /TN "${taskName}"`, `${cmdExePath} /d /s /c ${quotedScriptPath}`],
    };
  } catch (err) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup; keep the original restart failure.
    }
    return {
      ok: false,
      method: "schtasks",
      detail: formatErrorMessage(err),
      tried: [`schtasks /Run /TN "${taskName}"`],
    };
  }
}
