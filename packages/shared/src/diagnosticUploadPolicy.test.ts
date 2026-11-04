import assert from 'node:assert/strict';
import {resolveDiagnosticUploadUrl} from './diagnosticUploadPolicy';

test('diagnostics default closed, require a valid explicit receiver and respect opt-out above overrides',()=>{
 for(const url of [undefined,'','  ','not-a-url','file:///tmp/log','https://user:secret@receiver.test','https://receiver.test?q=token']) {
  assert.equal(resolveDiagnosticUploadUrl({SLOCK_DAEMON_TRACE_UPLOAD_URL:url}),undefined);
 }
 assert.equal(resolveDiagnosticUploadUrl({SLOCK_DAEMON_TRACE_UPLOAD_URL:' http://receiver.test/prefix/ '}),'http://receiver.test/prefix');
 assert.equal(resolveDiagnosticUploadUrl({},'https://receiver.test'),'https://receiver.test');
 assert.equal(resolveDiagnosticUploadUrl({SLOCK_DAEMON_TRACE_UPLOAD_DISABLED:'1',SLOCK_DAEMON_TRACE_UPLOAD_URL:'https://receiver.test'},'http://override.test'),undefined);
});
