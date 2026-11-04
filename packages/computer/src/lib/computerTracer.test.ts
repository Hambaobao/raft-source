import assert from "node:assert/strict";

import { computerLocalTraceDisabled } from "./computerTracer";

test("computerLocalTraceDisabled uses RAFT_COMPUTER_LOCAL_TRACE", () => {
  assert.equal(computerLocalTraceDisabled({}), false);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "0" }), true);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "1" }), false);
});

// Local-only traces remain available without becoming future upload inputs.
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {vi} from 'vitest';
import {createComputerTracer} from './computerTracer';

test('Computer records local diagnostics separately when upload is disabled, then keeps later eligible traces separate',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'computer-local-policy-'));
 try {
  vi.stubEnv('RAFT_COMPUTER_LOCAL_TRACE','1');vi.stubEnv('SLOCK_DAEMON_TRACE_UPLOAD_DISABLED','1');
  vi.stubEnv('SLOCK_DAEMON_TRACE_UPLOAD_URL','http://receiver.test');
  const local=createComputerTracer(home,'computer.cli');local.emitEvent('computer.local_only_test',{surface:'computer'});
  const localDir=path.join(home,'computer','local-diagnostics','traces');
  const files=await readdir(localDir);assert.ok(files.length);
  assert.match(await readFile(path.join(localDir,files[0]),'utf8'),/computer.local_only_test/);
  assert.deepEqual(await readdir(path.join(home,'computer','traces')).catch(()=>[]),[]);
  vi.stubEnv('SLOCK_DAEMON_TRACE_UPLOAD_DISABLED','0');
  const enabled=createComputerTracer(home,'computer.cli');enabled.emitEvent('computer.upload_allowed_test',{surface:'computer'});
  const uploadDir=path.join(home,'computer','traces');
  for(const file of await readdir(uploadDir))assert.doesNotMatch(await readFile(path.join(uploadDir,file),'utf8'),/computer.local_only_test/);
 }finally{vi.unstubAllEnvs();await rm(home,{recursive:true,force:true});}
});
