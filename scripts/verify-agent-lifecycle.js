#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentConnection } = require('../dist/agent/connection');
const { deriveJobSigningSecret } = require('../dist/agent/job-signing');
const { readAuditEntries } = require('../dist/agent/audit');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const server = new WebSocketServer({ port: 0 });
  const port = await waitForListening(server);
  const gatewayUrl = `ws://127.0.0.1:${port}`;
  const serverMessages = [];
  const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-watch-'));
  process.env.CI_DESKTOP_AGENT_AUDIT_PATH = path.join(watchRoot, 'audit.jsonl');
  let serverSocket;

  server.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (data) => {
      serverMessages.push(JSON.parse(data.toString()));
    });
  });

  const settings = {
    deviceId: 'verify-device',
    displayName: 'Verifier Mac',
    launchAtLogin: false,
    enabled: true,
    ownerUserId: 'verify-user',
    deviceToken: 'verify-token',
    jobSigningSecret: deriveJobSigningSecret('verify-token'),
    gatewayUrl,
    fileAccessMode: 'selected_folders',
    allowedFolders: [watchRoot],
    controlMode: 'disabled',
    approvalMode: 'session',
    allowShell: false,
    deviceApprovalGrants: [],
  };

  const missingDeviceConnection = new AgentConnection(() => ({
    ...settings,
    deviceId: undefined,
  }));
  missingDeviceConnection.connect();
  assert(
    missingDeviceConnection.getSnapshot().connection === 'error' &&
    missingDeviceConnection.getSnapshot().lastError.includes('deviceId'),
    'enabled agent should fail closed before connecting without a paired deviceId',
  );

  const missingOwnerConnection = new AgentConnection(() => ({
    ...settings,
    ownerUserId: undefined,
  }));
  missingOwnerConnection.connect();
  assert(
    missingOwnerConnection.getSnapshot().connection === 'error' &&
    missingOwnerConnection.getSnapshot().lastError.includes('ownerUserId'),
    'enabled agent should fail closed before connecting without a paired ownerUserId',
  );

  const missingTokenConnection = new AgentConnection(() => ({
    ...settings,
    deviceToken: undefined,
    jobSigningSecret: undefined,
  }));
  missingTokenConnection.connect();
  assert(
    missingTokenConnection.getSnapshot().connection === 'error' &&
    missingTokenConnection.getSnapshot().lastError.includes('device token'),
    'enabled agent should fail closed before connecting without a device token',
  );

  const connection = new AgentConnection(() => settings);
  connection.connect();

  await waitForMessage(serverMessages, (message) => message.type === 'hello');
  const initialHeartbeat = await waitForMessage(serverMessages, (message) => message.type === 'heartbeat');
  assert(
    initialHeartbeat.capabilities?.includes('screen.screenshot'),
    'desktop heartbeat should include capability names for backend freshness',
  );
  assert(
    initialHeartbeat.capabilityManifest?.some((capability) => capability.name === 'screen.screenshot'),
    'desktop heartbeat should include capability manifest for backend freshness',
  );
  assert(serverSocket, 'server should receive an agent socket');

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_unsigned_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'unsigned job' },
  }));
  const unsignedJobResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_unsigned_job' &&
    message.status === 'failed'
  ));
  assert(
    unsignedJobResult.error.includes('signature is required'),
    'unsigned jobs should fail when a signing secret exists',
  );

  const signedJob = signJob({
    type: 'job.start',
    jobId: 'verify_signed_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    targetDeviceId: 'verify-device',
    chatId: 'verify-chat',
    args: { message: 'signed prompt' },
  }, settings.jobSigningSecret);
  serverSocket.send(JSON.stringify(signedJob));
  const signedPrompt = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_signed_job'
  ));
  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_signed_job',
    promptId: signedPrompt.promptId,
    response: { value: 'signed ok' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_signed_job' &&
    message.status === 'completed'
  ));
  const signedJobAuditEntry = readAuditEntries(20).find((entry) => (
    entry.jobId === 'verify_signed_job' &&
    entry.action === 'job.start'
  ));
  assert(signedJobAuditEntry, 'remote job start should write an audit entry');
  assert(signedJobAuditEntry.ownerUserId === 'verify-user', 'remote job audit should include ownerUserId');
  assert(signedJobAuditEntry.targetDeviceId === 'verify-device', 'remote job audit should include targetDeviceId');
  assert(signedJobAuditEntry.chatId === 'verify-chat', 'remote job audit should include chatId');

  serverSocket.send(JSON.stringify(signedJob));
  const replayedSignatureResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_signed_job' &&
    message.status === 'failed'
  ));
  assert(
    replayedSignatureResult.error.includes('nonce has already been used'),
    'replayed signed job envelopes should fail nonce replay validation',
  );

  serverSocket.send(JSON.stringify(signJob({
    type: 'job.start',
    jobId: 'verify_signed_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'signed prompt' },
  }, settings.jobSigningSecret)));
  const freshDuplicateResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_signed_job' &&
    message.status === 'completed'
  ));
  assert(
    freshDuplicateResult.result?.value === 'signed ok',
    'freshly signed duplicate job should return the cached terminal result',
  );

  const tamperedJob = signJob({
    type: 'job.start',
    jobId: 'verify_tampered_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'original' },
  }, settings.jobSigningSecret);
  tamperedJob.args.message = 'tampered';
  serverSocket.send(JSON.stringify(tamperedJob));
  const tamperedJobResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_tampered_job' &&
    message.status === 'failed'
  ));
  assert(
    tamperedJobResult.error.includes('signature verification failed'),
    'tampered signed jobs should fail signature verification',
  );

  serverSocket.send(JSON.stringify(signJob({
    type: 'job.start',
    jobId: 'verify_expired_signature_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'expired signature' },
  }, settings.jobSigningSecret, {
    signedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  })));
  const expiredSignatureResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_expired_signature_job' &&
    message.status === 'failed'
  ));
  assert(
    expiredSignatureResult.error.includes('signature has expired'),
    'expired signed jobs should fail signature freshness validation',
  );

  serverSocket.send(JSON.stringify(signJob({
    type: 'job.start',
    jobId: 'verify_future_signature_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'future signature' },
  }, settings.jobSigningSecret, {
    signedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  })));
  const futureSignatureResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_future_signature_job' &&
    message.status === 'failed'
  ));
  assert(
    futureSignatureResult.error.includes('signature is from the future'),
    'future signed jobs should fail signature freshness validation',
  );

  settings.jobSigningSecret = undefined;

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_missing_tool_job',
    args: { message: 'missing tool' },
  }));

  const missingToolResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_missing_tool_job' &&
    message.status === 'failed'
  ));
  assert(
    missingToolResult.error.includes('job.start.tool must be a non-empty string'),
    'malformed job.start without tool should fail envelope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_bad_policy_job',
    tool: 'agent.ask_user',
    args: { message: 'bad policy' },
    policy: { timeoutMs: 'not-a-number' },
  }));

  const badPolicyResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_bad_policy_job' &&
    message.status === 'failed'
  ));
  assert(
    badPolicyResult.error.includes('job.start.policy.timeoutMs'),
    'malformed job.start policy should fail envelope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_bad_screenshot_policy_job',
    tool: 'agent.ask_user',
    args: { message: 'bad screenshot policy' },
    policy: { screenshotAfterAction: 'yes' },
  }));

  const badScreenshotPolicyResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_bad_screenshot_policy_job' &&
    message.status === 'failed'
  ));
  assert(
    badScreenshotPolicyResult.error.includes('job.start.policy.screenshotAfterAction'),
    'malformed screenshot-after-action policy should fail envelope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_wrong_owner_job',
    tool: 'agent.ask_user',
    ownerUserId: 'other-user',
    args: { message: 'wrong owner' },
  }));

  const wrongOwnerResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_wrong_owner_job' &&
    message.status === 'failed'
  ));
  assert(
    wrongOwnerResult.error.includes('ownerUserId does not match'),
    'job.start for a different owner should fail desktop scope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_missing_owner_job',
    tool: 'agent.ask_user',
    args: { message: 'missing owner' },
  }));

  const missingOwnerResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_missing_owner_job' &&
    message.status === 'failed'
  ));
  assert(
    missingOwnerResult.error.includes('ownerUserId is required'),
    'job.start without ownerUserId should fail desktop owner scope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_wrong_device_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    targetDeviceId: 'other-device',
    args: { message: 'wrong device' },
  }));

  const wrongDeviceResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_wrong_device_job' &&
    message.status === 'failed'
  ));
  assert(
    wrongDeviceResult.error.includes('targetDeviceId does not match'),
    'job.start for a different device should fail desktop scope validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.cancel',
    jobId: 'verify_bad_cancel_job',
    reason: 123,
  }));

  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_bad_cancel_job' &&
    message.message.includes('reason must be a string')
  ));

  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_bad_response_job',
    response: { value: 'missing prompt id' },
  }));

  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_bad_response_job' &&
    message.message.includes('promptId must be a non-empty string')
  ));

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_invalid_prompt_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 123 },
  }));

  const invalidResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_invalid_prompt_job' &&
    message.status === 'failed'
  ));
  assert(
    invalidResult.error.includes('args.message must be a string'),
    'remote synthetic prompt job should fail schema validation',
  );

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_timeout_prompt_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier timeout prompt' },
    policy: { timeoutMs: 1 },
  }));
  const timeoutPrompt = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_timeout_prompt_job'
  ));
  const timeoutResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_timeout_prompt_job' &&
    message.status === 'failed'
  ), 4000);
  assert(
    timeoutResult.error.includes('Job timed out after 1000ms'),
    'prompt job should respect the per-job timeout',
  );
  await waitUntil(() => !connection.getSnapshot().activeJobIds.includes('verify_timeout_prompt_job'));

  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_timeout_prompt_job',
    promptId: timeoutPrompt.promptId,
    response: { value: 'late response' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_timeout_prompt_job' &&
    message.message.includes('Ignored response for unknown prompt')
  ));

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_cached_result_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier cached prompt' },
  }));
  const cachedPrompt = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_cached_result_job'
  ));
  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_cached_result_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier cached prompt duplicate' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_cached_result_job' &&
    message.message.includes('already running')
  ));
  const duplicateActivePromptCount = serverMessages.filter((message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_cached_result_job'
  )).length;
  assert(duplicateActivePromptCount === 1, 'duplicate active job should not create a second prompt');

  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_cached_result_job',
    promptId: cachedPrompt.promptId,
    response: { value: 'cached answer' },
  }));
  const completedCachedJob = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_cached_result_job' &&
    message.status === 'completed'
  ));
  assert(completedCachedJob.result.value === 'cached answer', 'prompt response should complete cached-result job');

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_cached_result_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier cached prompt after completion' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_cached_result_job' &&
    message.message.includes('cached result')
  ));
  const cachedResults = await waitForMessages(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_cached_result_job' &&
    message.status === 'completed'
  ), 2);
  assert(cachedResults[1].result.value === 'cached answer', 'duplicate completed job should return cached result');
  const cachedPromptCount = serverMessages.filter((message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_cached_result_job'
  )).length;
  assert(cachedPromptCount === 1, 'duplicate completed job should not prompt again');

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_file_watch_job',
    tool: 'files.watch',
    ownerUserId: 'verify-user',
    targetDeviceId: 'verify-device',
    chatId: 'verify-watch-chat',
    args: {
      path: watchRoot,
      intervalMs: 1000,
      durationMs: 2500,
      maxEvents: 5,
    },
    policy: {
      approvalMode: 'always_for_owner',
      timeoutMs: 5000,
    },
  }));
  const fileWatchApproval = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_file_watch_job' &&
    message.kind === 'approval'
  ));
  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_file_watch_job',
    promptId: fileWatchApproval.promptId,
    response: { approved: true, scope: 'once' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.progress' &&
    message.jobId === 'verify_file_watch_job' &&
    message.message.includes('Watching')
  ));
  fs.writeFileSync(path.join(watchRoot, 'created-by-watch.txt'), 'watch me');
  const fileEvent = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.file_event' &&
    message.jobId === 'verify_file_watch_job' &&
    message.event.action === 'created' &&
    message.event.path.endsWith('created-by-watch.txt')
  ), 5000);
  assert(fileEvent.event.type === 'file', 'file watch event should identify created file');
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_file_watch_job' &&
    message.status === 'completed'
  ), 6000);
  const fileWatchApprovalAuditEntry = readAuditEntries(50).find((entry) => (
    entry.jobId === 'verify_file_watch_job' &&
    entry.action === 'approval.decision'
  ));
  assert(fileWatchApprovalAuditEntry, 'approval response should write an audit entry');
  assert(fileWatchApprovalAuditEntry.result === 'allowed', 'approval audit should record allowed result');
  assert(fileWatchApprovalAuditEntry.approvalSource === 'once', 'approval audit should record one-time scope');
  assert(fileWatchApprovalAuditEntry.ownerUserId === 'verify-user', 'approval audit should include ownerUserId');
  assert(fileWatchApprovalAuditEntry.targetDeviceId === 'verify-device', 'approval audit should include targetDeviceId');
  assert(fileWatchApprovalAuditEntry.chatId === 'verify-watch-chat', 'approval audit should include chatId');
  assert(fileWatchApprovalAuditEntry.target === watchRoot, 'approval audit should include safe target path');

  const deniedPath = path.join(watchRoot, 'denied-write.txt');
  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_denied_approval_job',
    tool: 'files.write',
    ownerUserId: 'verify-user',
    targetDeviceId: 'verify-device',
    chatId: 'verify-denied-chat',
    args: {
      path: deniedPath,
      content: 'this should not be written',
    },
    policy: {
      approvalMode: 'always_for_owner',
      timeoutMs: 5000,
    },
  }));
  const deniedApprovalPrompt = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_denied_approval_job' &&
    message.kind === 'approval'
  ));
  serverSocket.send(JSON.stringify({
    type: 'job.user_response',
    jobId: 'verify_denied_approval_job',
    promptId: deniedApprovalPrompt.promptId,
    response: { approved: false, scope: 'once' },
  }));
  const deniedApprovalResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_denied_approval_job' &&
    message.status === 'failed'
  ));
  assert(deniedApprovalResult.error === 'User denied approval', 'denied approval should fail the job');
  assert(!fs.existsSync(deniedPath), 'denied approval should prevent file write execution');
  const deniedApprovalAuditEntry = readAuditEntries(80).find((entry) => (
    entry.jobId === 'verify_denied_approval_job' &&
    entry.action === 'approval.decision'
  ));
  assert(deniedApprovalAuditEntry, 'denied approval should write an audit entry');
  assert(deniedApprovalAuditEntry.result === 'denied', 'denied approval audit should record denied result');
  assert(deniedApprovalAuditEntry.approvalSource === 'once', 'denied approval audit should record response scope');
  assert(deniedApprovalAuditEntry.chatId === 'verify-denied-chat', 'denied approval audit should include chatId');
  assert(deniedApprovalAuditEntry.target === deniedPath, 'denied approval audit should include safe target path');
  assert(!JSON.stringify(deniedApprovalAuditEntry).includes('this should not be written'), 'denied approval audit should not include blocked file content');

  const helloCountBeforeReconnect = serverMessages.filter((message) => message.type === 'hello').length;
  serverSocket.close();
  await waitUntil(() => Boolean(connection.getSnapshot().nextReconnectAt));
  const reconnectSnapshot = connection.getSnapshot();
  assert(reconnectSnapshot.reconnectAttempt >= 1, 'unexpected disconnect should increment reconnect attempt');
  assert(typeof reconnectSnapshot.nextReconnectAt === 'string', 'unexpected disconnect should expose next reconnect time');
  assert(reconnectSnapshot.nextReconnectDelayMs >= 1000, 'unexpected disconnect should expose reconnect delay');
  connection.reconnectNow('verify_wake_reconnect');
  assert(connection.getSnapshot().nextReconnectAt === undefined, 'forced reconnect should clear pending reconnect timer');
  await waitForMessages(serverMessages, (message) => message.type === 'hello', helloCountBeforeReconnect + 1, 4000);
  await waitUntil(() => connection.getSnapshot().nextReconnectAt === undefined);
  assert(connection.getSnapshot().reconnectAttempt === 0, 'successful reconnect should reset reconnect attempt');

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_sleep_prompt_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier sleep prompt' },
  }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_sleep_prompt_job'
  ));
  connection.pauseForSleep('verify_sleep');
  const sleepCancelResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_sleep_prompt_job' &&
    message.status === 'cancelled'
  ));
  assert(sleepCancelResult.error === 'verify_sleep', 'sleep pause should report sleep cancellation');
  assert(connection.getSnapshot().connection === 'disconnected', 'sleep pause should leave enabled agent disconnected');
  assert(connection.getSnapshot().nextReconnectAt === undefined, 'sleep pause should not schedule reconnect backoff');
  assert(
    !connection.getSnapshot().activeJobIds.includes('verify_sleep_prompt_job'),
    'sleep pause should clear active jobs',
  );

  const helloCountBeforeWake = serverMessages.filter((message) => message.type === 'hello').length;
  connection.reconnectNow('verify_after_sleep');
  await waitForMessages(serverMessages, (message) => message.type === 'hello', helloCountBeforeWake + 1, 4000);

  serverSocket.send(JSON.stringify({
    type: 'job.start',
    jobId: 'verify_prompt_job',
    tool: 'agent.ask_user',
    ownerUserId: 'verify-user',
    args: { message: 'Verifier prompt' },
  }));

  await waitForMessage(serverMessages, (message) => (
    message.type === 'job.input_required' &&
    message.jobId === 'verify_prompt_job'
  ));

  assert(
    connection.getSnapshot().activeJobIds.includes('verify_prompt_job'),
    'prompt job should be active before disconnect',
  );
  const activePromptSummary = connection.getSnapshot().activeJobs.find((job) => (
    job.jobId === 'verify_prompt_job'
  ));
  assert(activePromptSummary, 'active job summary should include prompt job');
  assert(activePromptSummary.tool === 'agent.ask_user', 'active job summary should include tool');
  assert(typeof activePromptSummary.startedAt === 'string', 'active job summary should include start time');

  serverSocket.send(JSON.stringify({ type: 'ping' }));
  await waitForMessage(serverMessages, (message) => (
    message.type === 'heartbeat' &&
    message.activeJobIds?.includes('verify_prompt_job') &&
    message.activeJobs?.some((job) => (
      job.jobId === 'verify_prompt_job' &&
      job.tool === 'agent.ask_user'
    ))
  ));

  connection.disconnect();

  const cancelResult = await waitForMessage(serverMessages, (message) => (
    message.type === 'job.result' &&
    message.jobId === 'verify_prompt_job' &&
    message.status === 'cancelled'
  ));
  assert(cancelResult.error === 'desktop_agent_kill_switch', 'disconnect should report kill-switch cancellation');

  await waitUntil(() => !connection.getSnapshot().activeJobIds.includes('verify_prompt_job'));
  assert(
    !connection.getSnapshot().activeJobs.some((job) => job.jobId === 'verify_prompt_job'),
    'active job summary should be cleared after disconnect cancellation',
  );

  serverSocket.terminate();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(watchRoot, { recursive: true, force: true });
  await verifyHttpPollingAuthFailureCancelsActiveJobs();
  console.log('Agent lifecycle verification passed');
}

async function verifyHttpPollingAuthFailureCancelsActiveJobs() {
  let claimCount = 0;
  const httpRequests = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    httpRequests.push({ method: request.method, pathname: url.pathname });

    if (request.method === 'POST' && url.pathname === '/api/desktop/devices/http-device/jobs/claim') {
      claimCount += 1;
      if (claimCount === 1) {
        writeJson(response, 200, {
          jobs: [
            {
              type: 'job.start',
              jobId: 'http_prompt_job',
              tool: 'agent.ask_user',
              ownerUserId: 'http-user',
              targetDeviceId: 'http-device',
              args: { message: 'HTTP prompt' },
            },
          ],
          commands: [],
        });
        return;
      }
      writeJson(response, 401, { error: 'Invalid desktop device token' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/desktop/devices/http-device/heartbeat') {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/desktop/jobs/http_prompt_job/events') {
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 404, { error: 'not found' });
  });

  const port = await waitForListening(server);
  const connection = new AgentConnection(() => ({
    deviceId: 'http-device',
    displayName: 'HTTP Verifier Mac',
    launchAtLogin: false,
    enabled: true,
    ownerUserId: 'http-user',
    deviceToken: 'http-token',
    gatewayUrl: `http://127.0.0.1:${port}`,
    fileAccessMode: 'selected_folders',
    allowedFolders: [],
    controlMode: 'disabled',
    approvalMode: 'session',
    allowShell: false,
    deviceApprovalGrants: [],
  }));

  try {
    connection.connect();
    await waitUntil(() => (
      connection.getSnapshot().connection === 'connected' &&
      connection.getSnapshot().activeJobIds.includes('http_prompt_job')
    ), 4000);
    assert(
      httpRequests.some((item) => item.pathname === '/api/desktop/jobs/http_prompt_job/events'),
      'HTTP prompt job should send input-required event to backend',
    );

    await waitUntil(() => (
      connection.getSnapshot().connection === 'error' &&
      !connection.getSnapshot().activeJobIds.includes('http_prompt_job')
    ), 5000);
    assert(
      connection.getSnapshot().lastError.includes('HTTP desktop gateway claim failed with 401'),
      'HTTP auth failure should be visible in desktop agent status',
    );
    assert(
      !connection.getSnapshot().activeJobs.some((job) => job.jobId === 'http_prompt_job'),
      'HTTP auth failure should clear active job summaries',
    );
  } finally {
    connection.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function waitForListening(server) {
  return new Promise((resolve) => {
    server.on('listening', () => {
      resolve(server.address().port);
    });
  });
}

async function waitForMessage(messages, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for expected message. Recent messages: ${JSON.stringify(messages.slice(-8))}`);
}

async function waitForMessages(messages, predicate, count, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matches = messages.filter(predicate);
    if (matches.length >= count) return matches;
    await sleep(20);
  }
  throw new Error('Timed out waiting for expected messages');
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for condition');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signJob(job, signingSecret, options = {}) {
  const crypto = require('crypto');
  const signedAt = options.signedAt || new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    ...job,
    signature: {
      algorithm: 'hmac-sha256',
      signedAt,
      nonce,
      value: crypto.createHmac('sha256', signingSecret)
        .update(stableStringify({
          jobId: job.jobId,
          tool: job.tool,
          ownerUserId: job.ownerUserId,
          targetDeviceId: job.targetDeviceId,
          chatId: job.chatId,
          args: job.args || {},
          policy: job.policy || {},
          signedAt,
          nonce,
        }))
        .digest('hex'),
    },
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
