import assert from "node:assert/strict";
import {
  requestDaemonScopeAttestation,
  uploadWithSignedCapability,
} from "./directUploadCapability";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requestDaemonScopeAttestation pulls a machine-auth capability from the server", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];

  const capability = await requestDaemonScopeAttestation({
    serverUrl: "https://slock.test/",
    apiKey: "sk_machine_test",
    scope: "feedback-report:create",
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        init,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({
        attestation: "signed-token",
        scope: "feedback-report:create",
        audience: "feedback-worker",
        resource: "reports/agent-1",
        expiresAt: "2026-04-26T00:00:00.000Z",
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slock.test/internal/machine/scope-attestation");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer sk_machine_test");
  assert.deepEqual(calls[0].body, {
    scope: "feedback-report:create",
  });
  assert.equal(capability.attestation, "signed-token");
});

test("requestDaemonScopeAttestation forwards caller metadata for server signing", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];

  await requestDaemonScopeAttestation({
    serverUrl: "https://slock.test/",
    apiKey: "sk_machine_test",
    scope: "daemon-trace-bundle:create",
    metadata: {
      bundleId: "bundle-1",
      bundleSha256: "a".repeat(64),
      bundleSizeBytes: 42,
    },
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        init,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({
        attestation: "signed-token",
        scope: "daemon-trace-bundle:create",
        audience: "trace-ingest-worker",
        resource: "servers/server-1/machines/machine-1/trace-bundles",
        metadata: { uploadId: "upload-1" },
        expiresAt: "2026-04-26T00:00:00.000Z",
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    scope: "daemon-trace-bundle:create",
    metadata: {
      bundleId: "bundle-1",
      bundleSha256: "a".repeat(64),
      bundleSizeBytes: 42,
    },
  });
});

test("uploadWithSignedCapability keeps server out of upload data plane", async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];

  await uploadWithSignedCapability({
    serverUrl: "https://slock.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    scope: "feedback-report:create",
    createBody: { filename: "bundle.json" },
    uploadBody: new Blob(["bundle"]),
    fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
      calls.push({ url, init, body });

      if (url === "https://slock.test/internal/machine/scope-attestation") {
        return jsonResponse({
          attestation: "signed-token",
          scope: "feedback-report:create",
          audience: "feedback-worker",
          resource: "reports/agent-1",
          expiresAt: "2026-04-26T00:00:00.000Z",
        });
      }

      if (url === "https://worker.test/api/uploads") {
        return jsonResponse({
          upload: {
            method: "PUT",
            url: "https://storage.test/upload/bundle",
            headers: { "Content-Type": "application/json" },
          },
          id: "upload-1",
        });
      }

      if (url === "https://storage.test/upload/bundle") {
        return new Response(null, { status: 200 });
      }

      return jsonResponse({ error: "unexpected url" }, 500);
    },
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://slock.test/internal/machine/scope-attestation",
    "https://worker.test/api/uploads",
    "https://storage.test/upload/bundle",
  ]);
  assert.deepEqual(calls[1].body, {
    filename: "bundle.json",
    attestation: "signed-token",
  });
  assert.ok(calls[2].body instanceof Blob, "upload bytes should be sent to storage URL, not server");
});

test("requestDaemonScopeAttestation classifies an HTML 413 from the server as 413", async () => {
  await assert.rejects(
    requestDaemonScopeAttestation({
      serverUrl: "https://slock.test/",
      apiKey: "sk_machine_test",
      scope: "daemon-trace-bundle:create",
      metadata: { bundleId: "b", bundleSha256: "a".repeat(64), bundleSizeBytes: 1 },
      fetchImpl: async () => new Response("<html>request entity too large</html>", { status: 413, headers: { "Content-Type": "text/html" } }),
    }),
    /Failed to request daemon scope attestation \(413\)/,
  );
});

import {vi} from 'vitest';
test('diagnostic upload opt-out blocks the shared feedback/trace data plane before signing, without blocking other uploads',async()=>{
 const calls:string[]=[];
 const fetchImpl=async(url:string)=>{calls.push(url);return jsonResponse({attestation:'synthetic-token',scope:'attachment:create',audience:'receiver',resource:'file',expiresAt:'2099-01-01T00:00:00Z',upload:{method:'PUT',url:'http://storage.test/file'}});};
 const options={serverUrl:'http://server.test',apiKey:'synthetic-key',workerUrl:'http://receiver.test',scope:'daemon-trace-bundle:create',createBody:{},uploadBody:new Blob(['synthetic content']),fetchImpl};
 try {
  vi.stubEnv('SLOCK_DAEMON_TRACE_UPLOAD_DISABLED','1');
  await assert.rejects(uploadWithSignedCapability(options),/DIAGNOSTIC_UPLOAD_DISABLED/);
  assert.deepEqual(calls,[]);
  await uploadWithSignedCapability({...options,scope:'attachment:create'});assert.equal(calls.length,3);
  calls.length=0;vi.stubEnv('SLOCK_DAEMON_TRACE_UPLOAD_DISABLED','0');
  await assert.rejects(uploadWithSignedCapability({...options,workerUrl:''}),/DIAGNOSTIC_UPLOAD_DISABLED/);assert.deepEqual(calls,[]);
 }finally{vi.unstubAllEnvs();}
});
