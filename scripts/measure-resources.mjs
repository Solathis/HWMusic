#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POWER_SHELL = "powershell.exe";

function groupForProcess(process) {
  const commandLine = process.commandLine ?? "";
  if (/hwmusic-core/i.test(commandLine)) return "core";
  const match = /--user-data-dir=(?:"([^"]+)"|([^\s]+))/i.exec(commandLine);
  if (!match) return null;
  const directory = (match[1] ?? match[2]).replaceAll("\\", "/").replaceAll(/^\/+|\/+$/g, "");
  const withoutDrive = directory.replace(/^[A-Za-z]:\/?/, "");
  const parts = withoutDrive.split("/").filter(Boolean);
  return `webview:${parts.slice(-2).join("/")}`;
}

/** @param {Array<{pid:number, ppid:number, name:string, commandLine:string, workingSetBytes:number, privateBytes:number, cpuSeconds:number}>} processes */
export function groupProcessTree(processes, rootPid) {
  const byPid = new Map(processes.map((process) => [Number(process.pid), process]));
  const children = new Map();
  for (const process of processes) {
    const parentPid = Number(process.ppid);
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(process);
  }

  const groups = new Map();
  const assigned = new Map();
  const addToGroup = (process, key) => {
    const current = groups.get(key) ?? {
      key,
      count: 0,
      workingSetBytes: 0,
      privateBytes: 0,
      cpuSeconds: 0,
    };
    current.count += 1;
    current.workingSetBytes += Number(process.workingSetBytes) || 0;
    current.privateBytes += Number(process.privateBytes) || 0;
    current.cpuSeconds += Number(process.cpuSeconds) || 0;
    groups.set(key, current);
    assigned.set(Number(process.pid), key);
  };

  const resolveGroup = (process, visiting = new Set()) => {
    const pid = Number(process.pid);
    if (assigned.has(pid)) return assigned.get(pid);
    if (visiting.has(pid)) return null;
    visiting.add(pid);

    let key = groupForProcess(process);
    if (pid === Number(rootPid)) key = "host";
    if (!key) {
      const parent = byPid.get(Number(process.ppid));
      key = parent ? resolveGroup(parent, visiting) : null;
    }
    if (key) addToGroup(process, key);
    return key;
  };

  const root = byPid.get(Number(rootPid));
  if (!root) return [];
  const visit = (process) => {
    resolveGroup(process);
    for (const child of children.get(Number(process.pid)) ?? []) visit(child);
  };
  visit(root);

  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

const POWER_SHELL_SCRIPT = String.raw`
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, PrivatePageCount)
$metrics = @{}
foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
  try {
    $metrics[[int]$process.Id] = [pscustomobject]@{
      WorkingSetBytes = [int64]$process.WorkingSet64
      CpuSeconds = [double]$process.TotalProcessorTime.TotalSeconds
    }
  } catch {}
}
$rows = foreach ($process in $processes) {
  $metric = $metrics[[int]$process.ProcessId]
  [pscustomobject]@{
    pid = [int]$process.ProcessId
    ppid = [int]$process.ParentProcessId
    name = [string]$process.Name
    commandLine = [string]$process.CommandLine
    workingSetBytes = if ($null -eq $metric) { 0 } else { $metric.WorkingSetBytes }
    privateBytes = if ($null -eq $process.PrivatePageCount) { 0 } else { [int64]$process.PrivatePageCount }
    cpuSeconds = if ($null -eq $metric) { 0 } else { $metric.CpuSeconds }
  }
}
@($rows) | ConvertTo-Json -Compress -Depth 4
`;

function collectProcesses() {
  const result = spawnSync(POWER_SHELL, ["-NoProfile", "-NonInteractive", "-Command", POWER_SHELL_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || `PowerShell exited with ${result.status}`);
  const output = (result.stdout ?? "").trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function rootPidOf(processes) {
  const root = processes.find((process) => /hwmusic-core\.exe$/i.test(process.name ?? ""));
  if (!root) throw new Error("找不到 hwmusic-core.exe");
  return Number(root.ppid);
}

function parseArgs(argv) {
  let label;
  let cpuWindow;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--label") label = argv[++index];
    else if (argument === "--cpu-window") cpuWindow = Number(argv[++index]);
    else throw new Error(`未知参数：${argument}`);
  }
  if (!label) throw new Error("必须提供 --label");
  if (cpuWindow !== undefined && (!Number.isFinite(cpuWindow) || cpuWindow < 0)) {
    throw new Error("--cpu-window 必须是非负秒数");
  }
  return { label, cpuWindow };
}

function printGroups(groups) {
  for (const group of groups) {
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    console.log(`${group.key}\t${group.count}\t${mb(group.workingSetBytes)} MB\t${mb(group.privateBytes)} MB\t${group.cpuSeconds.toFixed(1)} CPU s`);
  }
}

async function main() {
  const { label, cpuWindow } = parseArgs(process.argv.slice(2));
  const first = collectProcesses();
  const rootPid = rootPidOf(first);
  const before = groupProcessTree(first, rootPid);
  let groups = before;
  if (cpuWindow !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, cpuWindow * 1000));
    const after = groupProcessTree(collectProcesses(), rootPid);
    const beforeByKey = new Map(before.map((group) => [group.key, group]));
    groups = after.map((group) => ({
      ...group,
      cpuSeconds: Math.max(0, group.cpuSeconds - (beforeByKey.get(group.key)?.cpuSeconds ?? 0)),
    }));
  }

  printGroups(groups);
  const outputPath = path.join(ROOT, ".tmp", "measure", `${label}.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ label, rootPid, cpuWindowSeconds: cpuWindow ?? null, groups }, null, 2)}\n`,
    "utf8",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
