import { createTraceClient, LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import path from "node:path";
import { noopTracer, resolveDiagnosticUploadUrl } from "@botiverse/raft-shared";
import { computerDir } from "../paths";
import type { ComputerTraceClientSource, ComputerTracer } from "./traceTypes";

/**
 * Build the env-gated Computer trace client for a given emitting `source`
 * (CLI vs menu-bar). Both surfaces share this so their spans land in the same
 * `<computerDir>/traces/` sink when uploads are configured, or a separate
 * `local-diagnostics/traces/` sink otherwise. Local-only records are never
 * picked up by a later migration diagnostics upload.
 * `RAFT_COMPUTER_LOCAL_TRACE=0` disables (default on, mirrors the daemon);
 * any setup failure falls back to noop.
 */
export function computerLocalTraceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAFT_COMPUTER_LOCAL_TRACE === "0";
}

export function createComputerTracer(slockHome: string, source: ComputerTraceClientSource): ComputerTracer {
  if (computerLocalTraceDisabled()) return noopTracer;
  try {
    const machineDir = resolveDiagnosticUploadUrl(process.env)
      ? computerDir(slockHome) : path.join(computerDir(slockHome), "local-diagnostics");
    return createTraceClient({ source, sinks: [new LocalRotatingTraceSink({ machineDir })] });
  } catch {
    return noopTracer;
  }
}
