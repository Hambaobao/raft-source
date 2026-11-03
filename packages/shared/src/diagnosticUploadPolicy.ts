/** Self-hosted diagnostics require an explicit receiver. Local tracing is separate. */
export function resolveDiagnosticUploadUrl(
  env: Readonly<Record<string, string | undefined>>,
  configuredUrl: string | null | undefined = env.SLOCK_DAEMON_TRACE_UPLOAD_URL,
): string | undefined {
  if (env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1") return undefined;
  const value = configuredUrl?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
