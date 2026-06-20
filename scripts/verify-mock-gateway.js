#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const port = Number(process.env.CI_DESKTOP_AGENT_VERIFY_PORT || 48491);
const baseUrl = `http://127.0.0.1:${port}`;
const agentUrl = `ws://127.0.0.1:${port}/desktop-agent/connect`;
const chatUrl = `ws://127.0.0.1:${port}/chat`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  await verifyPersistedState();
  await verifyHeartbeatTimeout();
  await verifyOwnerAllowlist();
  await verifyStrictDeviceTargeting();
  await verifyPairingTokenRequirement();
  await verifyChatApiTokenRequirement();
  await verifyReplayRetentionMetadata();

  const gateway = spawn(process.execPath, ['scripts/mock-agent-gateway.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI_DESKTOP_AGENT_MOCK_PORT: String(port),
      CI_DESKTOP_AGENT_REQUIRE_TOKEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  gateway.stdout.on('data', (chunk) => output.push(chunk.toString()));
  gateway.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHttp(`${baseUrl}/`, 5000);
    const chatPage = await getText(`${baseUrl}/`);
    assert(chatPage.includes('id="targetOwner"'), 'mock chat UI should expose owner targeting input');
    assert(chatPage.includes('id="targetChat"'), 'mock chat UI should expose chat targeting input');
    assert(chatPage.includes('id="chatApiToken"'), 'mock chat UI should expose mock chat API token input');
    assert(chatPage.includes('chatToken') && chatPage.includes('authedHeaders()'), 'mock chat UI should attach chat API auth to socket and fetch requests');
    assert(chatPage.includes('lastEventId') && chatPage.includes('eventIdStorageKey()'), 'mock chat UI should preserve event-id replay cursors');
    assert(chatPage.includes('chatId: currentChatId()'), 'mock chat UI should include chat scope in requests');
    assert(chatPage.includes('id="targetDevice"'), 'mock chat UI should expose target device selector');
    assert(chatPage.includes('...targetRequest()'), 'mock chat UI should include target scope in job requests');
    assert(chatPage.includes('...targetRequest(false)'), 'mock chat UI should include owner scope in cancel/respond requests');
    assert(chatPage.includes('renderDesktopStatusCard'), 'mock chat UI should render desktop status cards');
    assert(chatPage.includes('value.nextReconnectAt'), 'mock chat UI should render desktop reconnect timing');
    assert(chatPage.includes('permissionSummary(value.permissions)'), 'mock chat UI should summarize desktop permission readiness');
    assert(chatPage.includes('formatActiveJobs(device)'), 'mock chat UI should render structured active job summaries');
    assert(chatPage.includes('renderPromptCard(prompt)'), 'mock chat UI should render first-class prompt cards');
    assert(chatPage.includes('Secure Secret Request'), 'mock chat UI should label secure secret prompt cards');
    assert(chatPage.includes('markPromptResolved(prompt'), 'mock chat UI should track prompt response state');
    assert(chatPage.includes('Pending \' + promptTitle(prompt.kind)'), 'mock gateway state should render pending prompts as cards');
    assert(chatPage.includes('captureBounds.x + ((localX / imageWidth) * captureBounds.width)'), 'mock chat UI should map screenshot clicks through capture bounds when available');
    assert(chatPage.includes('renderFilePreview(filePreview)'), 'mock chat UI should render live-only file previews');
    assert(chatPage.includes('renderSourcePicker(sources)'), 'mock chat UI should render screen source quick actions');
    assert(chatPage.includes("sendToolJob('screen.screenshot'") && chatPage.includes("sendToolJob('screen.stream'"), 'source quick actions should send screenshot and stream jobs');
    assert(chatPage.includes('id="showAudit"'), 'mock chat UI should expose audit history control');
    assert(chatPage.includes('getAuditInfo()'), 'mock chat UI should call desktop audit info bridge');
    assert(chatPage.includes('clearAudit()'), 'mock chat UI should call desktop audit clear bridge');
    assert(chatPage.includes('id="chooseFolder"'), 'mock chat UI should expose folder chooser control');
    assert(chatPage.includes('clearAllowedFolders()'), 'mock chat UI should call desktop folder clear bridge');
    assert(chatPage.includes('openPermissionSettings(permission)'), 'mock chat UI should call desktop permission settings bridge');
    assert(chatPage.includes('id="setupChecklist"'), 'mock chat UI should expose setup checklist control');
    assert(chatPage.includes('getSetupChecklist()'), 'mock chat UI should call desktop setup checklist bridge');
    assert(chatPage.includes('id="launchAtLogin"'), 'mock chat UI should expose launch-at-login enable control');
    assert(chatPage.includes('id="disableLaunchAtLogin"'), 'mock chat UI should expose launch-at-login disable control');
    assert(
      chatPage.includes('updateSettings({ launchAtLogin: true })') &&
      chatPage.includes('updateSettings({ launchAtLogin: false })'),
      'mock chat UI should toggle launch-at-login through the trusted bridge',
    );
    assert(chatPage.includes("'full_disk_access'"), 'mock chat UI should expose Full Disk permission shortcut');
    assert(chatPage.includes("'accessibility'"), 'mock chat UI should expose Accessibility permission shortcut');
    assert(chatPage.includes("'screen_recording'"), 'mock chat UI should expose Screen Recording permission shortcut');
    assert(chatPage.includes("'automation'"), 'mock chat UI should expose Automation permission shortcut');

    const pairResponse = await postJson(`${baseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'verify-user',
      displayName: 'Verify Mac',
    });
    assert(pairResponse.deviceId, 'pair endpoint should return deviceId');
    assert(pairResponse.deviceToken, 'pair endpoint should return deviceToken');
    assert(pairResponse.ownerUserId === 'verify-user', 'pair endpoint should preserve owner');

    const invalidBrowserJob = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'browser.open_url',
      args: { url: 'file:///etc/passwd' },
    });
    assert(
      invalidBrowserJob.ok === false && String(invalidBrowserJob.error).includes('http or https URL'),
      'job API should reject browser URLs that fail the desktop capability schema',
    );

    const invalidInputJob = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'input.click',
      args: { x: 10, y: '20' },
    });
    assert(
      invalidInputJob.ok === false && String(invalidInputJob.error).includes('args.y must be a finite number'),
      'job API should reject structured tool args with wrong types',
    );

    const unknownArgJob = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'input.click',
      args: { x: 10, y: 20, z: 30 },
    });
    assert(
      unknownArgJob.ok === false && String(unknownArgJob.error).includes('args.z is not allowed'),
      'job API should reject unknown structured tool args',
    );

    const missingRequiredArgJob = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'files.copy',
      args: { sourcePath: '/tmp/source.txt' },
    });
    assert(
      missingRequiredArgJob.ok === false && String(missingRequiredArgJob.error).includes('args.destinationPath is required'),
      'job API should reject structured tool args with missing required fields',
    );

    const stateAfterInvalidJobs = await getJson(`${baseUrl}/api/state`);
    assert(
      stateAfterInvalidJobs.jobs.length === 0,
      'invalid structured jobs should not be persisted before delivery',
    );

    const queuedJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'open https://queued.example',
    });
    assert(queuedJobResponse.ok === true, 'offline job should be accepted');
    const queuedBeforeConnect = await getJson(`${baseUrl}/api/state`);
    assert(
      queuedBeforeConnect.jobs.some((stateJob) => (
        stateJob.id === queuedJobResponse.job.jobId &&
        stateJob.status === 'queued'
      )),
      'offline job should be queued before agent connects',
    );

    const expiringJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'browser.open_url',
      args: { url: 'https://expired.example' },
      policy: { timeoutMs: 5 },
    });
    assert(expiringJobResponse.ok === true, 'offline job with short timeout should be accepted');
    const expiredState = await waitForState(`${baseUrl}/api/state`, (state) => (
      state.jobs.some((stateJob) => (
        stateJob.id === expiringJobResponse.job.jobId &&
        stateJob.status === 'expired'
      ))
    ), 5000);
    assert(
      expiredState.events.some((event) => (
        event.type === 'job.expired' &&
        event.jobId === expiringJobResponse.job.jobId
      )),
      'expired offline job should append a job.expired event',
    );

    const queuedCancelJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'open https://cancelled-queued.example',
    });
    assert(queuedCancelJobResponse.ok === true, 'offline job for cancellation should be accepted');
    const queuedCancelResponse = await postJson(`${baseUrl}/api/jobs/${queuedCancelJobResponse.job.jobId}/cancel`, {
      reason: 'cancel_before_connect',
    });
    assert(
      queuedCancelResponse.ok === true && queuedCancelResponse.sent === 0,
      'queued job cancellation should succeed without a connected agent',
    );
    const cancelledQueuedState = await getJson(`${baseUrl}/api/state`);
    assert(
      cancelledQueuedState.jobs.some((stateJob) => (
        stateJob.id === queuedCancelJobResponse.job.jobId &&
        stateJob.status === 'cancelled'
      )),
      'cancelled queued job should become terminal before agent connects',
    );

    const agent = await openSocket(agentUrl, {
      headers: {
        authorization: `Bearer ${pairResponse.deviceToken}`,
      },
    });
    const chat = await openSocket(chatUrl);
    const agentMessages = collectMessages(agent);
    const chatMessages = collectMessages(chat);

    agent.send(JSON.stringify({
      type: 'hello',
      deviceId: pairResponse.deviceId,
      displayName: 'Verify Mac',
      agentVersion: 'verify',
      capabilities: ['agent.request_approval'],
      capabilityManifest: [{
        name: 'agent.request_approval',
        description: 'Verify approval prompt.',
        risk: 'medium',
        requiredMacPermissions: [],
        requiresApproval: false,
        canRunUnattended: false,
        inputSchema: { type: 'object' },
      }],
    }));

    await sleep(50);
    const pairedState = await getJson(`${baseUrl}/api/state`);
    assert(
      pairedState.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.status === 'online' &&
        device.capabilityManifest?.some((capability) => capability.name === 'agent.request_approval')
      )),
      'paired device should become online with capability manifest after hello',
    );

    const invalidResultJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      tool: 'system.info',
      args: {},
    });
    assert(invalidResultJobResponse.ok === true, 'invalid result verification job should be accepted');
    const invalidResultJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === invalidResultJobResponse.job.jobId &&
      message.tool === 'system.info'
    ));
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: invalidResultJob.jobId,
      status: 'completed',
      result: { hostname: 42 },
    }));
    const invalidResultState = await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user`, (state) => (
      state.events.some((event) => (
        event.type === 'agent.event.rejected' &&
        event.jobId === invalidResultJob.jobId &&
        event.payload?.reason === 'invalid_result' &&
        String(event.payload?.error || '').includes('result.hostname must be a string')
      ))
    ));
    assert(
      invalidResultState.jobs.some((stateJob) => (
        stateJob.id === invalidResultJob.jobId &&
        stateJob.status === 'running'
      )),
      'invalid completed job results should be rejected without making the job terminal',
    );
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: invalidResultJob.jobId,
      status: 'completed',
      result: { hostname: 'verify-host' },
    }));
    await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user`, (state) => (
      state.jobs.some((stateJob) => (
        stateJob.id === invalidResultJob.jobId &&
        stateJob.status === 'completed'
      ))
    ));

    agent.send(JSON.stringify({
      type: 'heartbeat',
      deviceId: pairResponse.deviceId,
      activeJobIds: ['verify-active-job'],
      activeJobs: [{
        jobId: 'verify-active-job',
        tool: 'screen.stream',
        ownerUserId: 'verify-user',
        targetDeviceId: pairResponse.deviceId,
        chatId: 'verify-chat',
        startedAt: '2026-06-19T00:00:00.000Z',
        secret: 'must-not-leak',
      }],
    }));
    const activeState = await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user`, (state) => (
      state.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.activeJobIds?.includes('verify-active-job') &&
        device.activeJobs?.some((job) => (
          job.jobId === 'verify-active-job' &&
          job.tool === 'screen.stream' &&
          job.ownerUserId === 'verify-user' &&
          job.targetDeviceId === pairResponse.deviceId &&
          job.chatId === 'verify-chat' &&
          job.startedAt === '2026-06-19T00:00:00.000Z'
        ))
      ))
    ));
    assert(
      !JSON.stringify(activeState).includes('must-not-leak'),
      'state API should sanitize active job summaries from heartbeat payloads',
    );
    const activeDevices = await getJson(`${baseUrl}/api/devices?ownerUserId=verify-user`);
    assert(
      activeDevices.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.activeJobs?.some((job) => job.jobId === 'verify-active-job' && job.tool === 'screen.stream')
      )),
      'devices API should expose structured active job summaries',
    );
    agent.send(JSON.stringify({
      type: 'heartbeat',
      deviceId: pairResponse.deviceId,
      activeJobIds: [],
      activeJobs: [],
    }));
    await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user`, (state) => (
      state.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        Array.isArray(device.activeJobs) &&
        device.activeJobs.length === 0
      ))
    ));

    const secondPairResponse = await postJson(`${baseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'verify-user',
      displayName: 'Second Verify Mac',
    });
    const otherOwnerPairResponse = await postJson(`${baseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'other-user',
      displayName: 'Other Owner Mac',
    });
    const verifyUserDevices = await getJson(`${baseUrl}/api/devices?ownerUserId=verify-user`);
    assert(
      verifyUserDevices.devices.every((device) => device.ownerUserId === 'verify-user'),
      'devices API should filter by ownerUserId',
    );
    assert(
      !JSON.stringify(verifyUserDevices).includes('deviceTokenHash'),
      'devices API should not expose device token hashes used for job signing',
    );
    assert(
      !verifyUserDevices.devices.some((device) => device.id === otherOwnerPairResponse.deviceId),
      'devices API should not include another owner device when scoped',
    );

    const secondAgent = await openSocket(agentUrl, {
      headers: {
        authorization: `Bearer ${secondPairResponse.deviceToken}`,
      },
    });
    const secondAgentMessages = collectMessages(secondAgent);
    secondAgent.send(JSON.stringify({
      type: 'hello',
      deviceId: secondPairResponse.deviceId,
      displayName: 'Second Verify Mac',
      agentVersion: 'verify',
      capabilities: ['browser.open_url'],
    }));
    await waitForState(`${baseUrl}/api/state`, (state) => (
      state.devices.some((device) => (
        device.id === secondPairResponse.deviceId &&
        device.status === 'online'
      ))
    ));

    const deliveredQueuedJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === queuedJobResponse.job.jobId &&
      message.tool === 'browser.open_url'
    ));
    assert(
      deliveredQueuedJob.args.url === 'https://queued.example',
      'queued job should be delivered after agent hello',
    );
    assert(
      deliveredQueuedJob.signature?.algorithm === 'hmac-sha256' &&
      /^[a-f0-9]{64}$/i.test(deliveredQueuedJob.signature.value || ''),
      'queued jobs should be signed before delivery to a paired device',
    );
    await assertNoMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === expiringJobResponse.job.jobId
    ), 'expired queued job should not be delivered after agent reconnect');
    await assertNoMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === queuedCancelJobResponse.job.jobId
    ), 'cancelled queued job should not be delivered after agent reconnect');
    const queuedAfterConnect = await getJson(`${baseUrl}/api/state`);
    assert(
      queuedAfterConnect.jobs.some((stateJob) => (
        stateJob.id === queuedJobResponse.job.jobId &&
        stateJob.status === 'running' &&
        stateJob.deliveryAttempts === 1
      )),
      'delivered queued job should move to running with one delivery attempt',
    );

    const runningTimeoutResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      chatId: 'verify-chat',
      deviceId: pairResponse.deviceId,
      tool: 'agent.request_approval',
      args: { message: 'This job should timeout on the gateway' },
      policy: { timeoutMs: 25 },
    });
    assert(runningTimeoutResponse.ok === true, 'running timeout job should be accepted');
    const runningTimeoutJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === runningTimeoutResponse.job.jobId
    ));
    assert(runningTimeoutJob.policy.timeoutMs === 25, 'running timeout job should deliver timeout policy');
    const timeoutCancel = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.cancel' &&
      message.jobId === runningTimeoutResponse.job.jobId &&
      message.reason === 'backend_timeout'
    ));
    assert(timeoutCancel.jobId === runningTimeoutResponse.job.jobId, 'backend timeout should cancel the desktop job');
    const runningExpiredState = await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=verify-chat`, (state) => (
      state.jobs.some((stateJob) => (
        stateJob.id === runningTimeoutResponse.job.jobId &&
        stateJob.status === 'expired' &&
        String(stateJob.error || '').includes('Running job expired')
      ))
    ));
    assert(
      runningExpiredState.events.some((event) => (
        event.type === 'job.expired' &&
        event.jobId === runningTimeoutResponse.job.jobId &&
        event.payload?.reason === 'backend_timeout'
      )),
      'expired running job should append a backend timeout event',
    );
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: runningTimeoutResponse.job.jobId,
      status: 'completed',
      result: { value: 'late result should be rejected' },
    }));
    await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=verify-chat`, (state) => (
      state.events.some((event) => (
        event.type === 'agent.event.rejected' &&
        event.jobId === runningTimeoutResponse.job.jobId &&
        event.payload?.reason === 'terminal_job'
      ))
    ));
    const afterLateResultState = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=verify-chat`);
    assert(
      afterLateResultState.jobs.some((stateJob) => (
        stateJob.id === runningTimeoutResponse.job.jobId &&
        stateJob.status === 'expired' &&
        !JSON.stringify(stateJob).includes('late result should be rejected')
      )),
      'late desktop result should not overwrite an expired running job',
    );

    const primaryTargetResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      chatId: 'verify-chat',
      deviceId: pairResponse.deviceId,
      command: 'open https://primary-target.example',
    });
    assert(primaryTargetResponse.deviceId === pairResponse.deviceId, 'primary targeted job should record target device');
    assert(primaryTargetResponse.ownerUserId === 'verify-user', 'primary targeted job should record owner');
    assert(primaryTargetResponse.chatId === 'verify-chat', 'primary targeted job should record chat');
    const primaryTargetJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === primaryTargetResponse.job.jobId &&
      message.args.url === 'https://primary-target.example'
    ));
    assert(
      primaryTargetJob.signature?.algorithm === 'hmac-sha256',
      'primary targeted job should be signed for the target device',
    );
    assert(
      primaryTargetJob.ownerUserId === 'verify-user' &&
      primaryTargetJob.targetDeviceId === pairResponse.deviceId &&
      primaryTargetJob.chatId === 'verify-chat',
      'primary targeted job should carry owner, target device, and chat metadata to the desktop',
    );
    await assertNoMessage(secondAgentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === primaryTargetResponse.job.jobId
    ), 'primary targeted job should not be delivered to second agent');

    secondAgent.send(JSON.stringify({
      type: 'job.result',
      jobId: primaryTargetResponse.job.jobId,
      status: 'completed',
      result: { spoofedByWrongDevice: true },
    }));
    await sleep(100);
    const afterSpoofedPrimaryResult = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=verify-chat`);
    assert(
      afterSpoofedPrimaryResult.jobs.some((stateJob) => (
        stateJob.id === primaryTargetResponse.job.jobId &&
        stateJob.status === 'running' &&
        !JSON.stringify(stateJob).includes('spoofedByWrongDevice')
      )),
      'gateway should reject job results from a desktop that was not assigned the job',
    );
    await assertNoMessage(chatMessages, (message) => (
      JSON.stringify(message).includes('spoofedByWrongDevice')
    ), 'wrong-device agent result should not be relayed to chat');

    const openBrowserResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'open-browser chrome :: https://browser-target.example',
    });
    assert(openBrowserResponse.ok === true, 'job API should accept open-browser command');
    const openBrowserJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === openBrowserResponse.job.jobId &&
      message.tool === 'browser.open_url'
    ));
    assert(
      openBrowserJob.args.browser === 'chrome' &&
      openBrowserJob.args.url === 'https://browser-target.example',
      'open-browser command should relay browser target and URL',
    );

    const chromeResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'chrome https://chrome-target.example',
    });
    assert(chromeResponse.ok === true, 'job API should accept chrome command');
    const chromeJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === chromeResponse.job.jobId &&
      message.tool === 'browser.open_url'
    ));
    assert(chromeJob.args.browser === 'chrome', 'chrome command should target Chrome');

    const safariResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'safari https://safari-target.example',
    });
    assert(safariResponse.ok === true, 'job API should accept safari command');
    const safariJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === safariResponse.job.jobId &&
      message.tool === 'browser.open_url'
    ));
    assert(safariJob.args.browser === 'safari', 'safari command should target Safari');

    const crossOwnerTargetResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: otherOwnerPairResponse.deviceId,
      command: 'open https://cross-owner.example',
    });
    assert(crossOwnerTargetResponse.ok === false, 'job API should reject cross-owner device targeting');

    const crossOwnerCancelResponse = await postJson(`${baseUrl}/api/jobs/${primaryTargetResponse.job.jobId}/cancel`, {
      ownerUserId: 'other-user',
      chatId: 'verify-chat',
      reason: 'wrong_owner',
    });
    assert(crossOwnerCancelResponse.ok === false, 'cancel API should reject cross-owner job cancellation');

    const crossChatCancelResponse = await postJson(`${baseUrl}/api/jobs/${primaryTargetResponse.job.jobId}/cancel`, {
      ownerUserId: 'verify-user',
      chatId: 'other-chat',
      reason: 'wrong_chat',
    });
    assert(crossChatCancelResponse.ok === false, 'cancel API should reject cross-chat job cancellation');

    const missingCancelResponse = await postJson(`${baseUrl}/api/jobs/job_missing_verify/cancel`, {
      reason: 'missing_job',
    });
    assert(missingCancelResponse.ok === false, 'cancel API should reject unknown job cancellation');

    const secondTargetResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: secondPairResponse.deviceId,
      command: 'open https://second-target.example',
    });
    assert(secondTargetResponse.deviceId === secondPairResponse.deviceId, 'second targeted job should record target device');
    const secondTargetJob = await waitForMessage(secondAgentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === secondTargetResponse.job.jobId &&
      message.args.url === 'https://second-target.example'
    ));
    assert(
      secondTargetJob.signature?.algorithm === 'hmac-sha256',
      'second targeted job should be signed for the target device',
    );
    assert(
      secondTargetJob.ownerUserId === 'verify-user' &&
      secondTargetJob.targetDeviceId === secondPairResponse.deviceId,
      'second targeted job should carry owner and target device metadata to the desktop',
    );
    await assertNoMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === secondTargetResponse.job.jobId
    ), 'second targeted job should not be delivered to primary agent');

    const routedState = await getJson(`${baseUrl}/api/state`);
    assert(
      routedState.jobs.some((stateJob) => (
        stateJob.id === secondTargetResponse.job.jobId &&
        stateJob.deviceId === secondPairResponse.deviceId
      )),
      'state should retain targeted device ID for routed jobs',
    );
    const verifyUserJobs = await getJson(`${baseUrl}/api/jobs?ownerUserId=verify-user`);
    assert(
      verifyUserJobs.jobs.every((stateJob) => stateJob.ownerUserId === 'verify-user'),
      'jobs API should filter by ownerUserId',
    );
    const verifyChatJobs = await getJson(`${baseUrl}/api/jobs?ownerUserId=verify-user&chatId=verify-chat`);
    assert(
      verifyChatJobs.jobs.length > 0 &&
      verifyChatJobs.jobs.every((stateJob) => (
        stateJob.ownerUserId === 'verify-user' &&
        stateJob.chatId === 'verify-chat'
      )),
      'jobs API should filter by ownerUserId and chatId',
    );
    const emptyChatJobs = await getJson(`${baseUrl}/api/jobs?ownerUserId=verify-user&chatId=missing-chat`);
    assert(emptyChatJobs.jobs.length === 0, 'jobs API should omit jobs from other chats');

    const otherOwnerJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'other-user',
      deviceId: otherOwnerPairResponse.deviceId,
      command: 'open https://other-owner.example',
    });
    assert(otherOwnerJobResponse.ok === true, 'other owner should be able to create its own scoped job');

    const verifyScopedState = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user`);
    assert(
      verifyScopedState.devices.every((device) => device.ownerUserId === 'verify-user'),
      'state API should filter devices by ownerUserId',
    );
    assert(
      verifyScopedState.jobs.every((stateJob) => stateJob.ownerUserId === 'verify-user'),
      'state API should filter jobs by ownerUserId',
    );
    assert(
      !JSON.stringify(verifyScopedState).includes(otherOwnerPairResponse.deviceId),
      'verify scoped state should not include another owner device',
    );
    assert(
      !JSON.stringify(verifyScopedState).includes(otherOwnerJobResponse.job.jobId),
      'verify scoped state should not include another owner job',
    );
    const verifyChatState = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=verify-chat`);
    assert(
      verifyChatState.jobs.length > 0 &&
      verifyChatState.jobs.every((stateJob) => stateJob.chatId === 'verify-chat'),
      'state API should filter jobs by chatId',
    );

    const otherScopedState = await getJson(`${baseUrl}/api/state?ownerUserId=other-user`);
    assert(
      otherScopedState.devices.some((device) => device.id === otherOwnerPairResponse.deviceId),
      'other-owner scoped state should include its device',
    );
    assert(
      otherScopedState.jobs.some((stateJob) => stateJob.id === otherOwnerJobResponse.job.jobId),
      'other-owner scoped state should include its job',
    );
    assert(
      !JSON.stringify(otherScopedState).includes(pairResponse.deviceId),
      'other-owner scoped state should not include verify owner device',
    );

    const verifyScopedEvents = await getJson(`${baseUrl}/api/events?after=0&ownerUserId=verify-user`);
    assert(
      verifyScopedEvents.events.some((event) => JSON.stringify(event).includes(pairResponse.deviceId)),
      'owner-scoped events should include matching owner device events',
    );
    assert(
      !JSON.stringify(verifyScopedEvents).includes(otherOwnerPairResponse.deviceId),
      'owner-scoped events should exclude another owner device events',
    );
    assert(
      !JSON.stringify(verifyScopedEvents).includes(otherOwnerJobResponse.job.jobId),
      'owner-scoped events should exclude another owner job events',
    );
    const verifyChatEvents = await getJson(`${baseUrl}/api/events?after=0&ownerUserId=verify-user&chatId=verify-chat`);
    assert(
      verifyChatEvents.events.length > 0 &&
      verifyChatEvents.events.every((event) => (
        event.chatId === 'verify-chat' ||
        event.payload?.chatId === 'verify-chat' ||
        event.payload?.jobId === primaryTargetResponse.job.jobId
      )),
      'event replay API should filter by ownerUserId and chatId',
    );

    const beforeResume = await getJson(`${baseUrl}/api/events?after=0&ownerUserId=verify-user`);
    const resumeJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'open https://resume-chat.example',
    });
    assert(resumeJobResponse.ok === true, 'resume verification job should be accepted');

    const resumedChat = await openSocket(`${chatUrl}?ownerUserId=verify-user&after=${beforeResume.lastSeq}`);
    const resumedChatMessages = collectMessages(resumedChat);
    await waitForMessage(resumedChatMessages, (message) => (
      message.replay === true &&
      message.event &&
      message.event.jobId === resumeJobResponse.job.jobId
    ));

    const eventIdCursorSource = beforeResume.events[beforeResume.events.length - 1];
    assert(eventIdCursorSource?.id, 'event replay API should expose stable event IDs');
    const eventIdResumeJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'open https://resume-chat-event-id.example',
    });
    assert(eventIdResumeJobResponse.ok === true, 'event-id resume verification job should be accepted');
    const eventIdReplay = await getJson(`${baseUrl}/api/events?ownerUserId=verify-user&lastEventId=${encodeURIComponent(eventIdCursorSource.id)}`);
    assert(
      eventIdReplay.replayFromSeq === eventIdCursorSource.seq &&
      eventIdReplay.events.some((event) => event.jobId === eventIdResumeJobResponse.job.jobId),
      'event replay API should accept lastEventId cursor values',
    );
    const staleEventIdReplay = await getJson(`${baseUrl}/api/events?ownerUserId=verify-user&after=${eventIdCursorSource.seq}&lastEventId=${encodeURIComponent('evt_missing_cursor')}`);
    assert(
      staleEventIdReplay.replayFromSeq === eventIdCursorSource.seq &&
      staleEventIdReplay.events.some((event) => event.jobId === eventIdResumeJobResponse.job.jobId),
      'event replay API should fall back to numeric cursor when lastEventId is unknown',
    );
    const eventIdChat = await openSocket(`${chatUrl}?ownerUserId=verify-user&lastEventId=${encodeURIComponent(eventIdCursorSource.id)}`);
    const eventIdChatMessages = collectMessages(eventIdChat);
    await waitForMessage(eventIdChatMessages, (message) => (
      message.replay === true &&
      message.event &&
      message.event.jobId === eventIdResumeJobResponse.job.jobId
    ));

    const scopedLiveChat = await openSocket(`${chatUrl}?ownerUserId=verify-user&after=0`);
    const scopedLiveMessages = collectMessages(scopedLiveChat);
    await waitForMessage(scopedLiveMessages, (message) => message.direction === 'system');
    const otherLiveJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'other-user',
      deviceId: otherOwnerPairResponse.deviceId,
      command: 'open https://other-live.example',
    });
    assert(otherLiveJobResponse.ok === true, 'other owner live job should be accepted');
    await assertNoMessage(scopedLiveMessages, (message) => (
      JSON.stringify(message).includes(otherLiveJobResponse.job.jobId)
    ), 'owner-scoped live chat should not receive another owner job event');
    scopedLiveChat.close();
    resumedChat.close();

    const jobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      chatId: 'prompt-chat',
      command: 'approval Approve a test action?',
    });

    assert(jobResponse.ok === true, 'job API should accept approval command');
    const job = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === jobResponse.job.jobId &&
      message.tool === 'agent.request_approval'
    ));
    assert(job.tool === 'agent.request_approval', 'agent should receive approval prompt job');

    const promptEvent = {
      type: 'job.input_required',
      jobId: job.jobId,
      promptId: 'prompt_verify',
      kind: 'approval',
      message: 'Approve verification?',
    };
    agent.send(JSON.stringify(promptEvent));

    const screenshotEvent = {
      type: 'job.screenshot',
      jobId: job.jobId,
      image: {
        mimeType: 'image/png',
        data: Buffer.from('fake').toString('base64'),
        width: 1440,
        height: 900,
        format: 'jpeg',
        quality: 70,
        sourceId: 'screen:verify',
        sourceType: 'screen',
        displayId: '1',
        bounds: { x: 100, y: 50, width: 1440, height: 900 },
        scaleFactor: 2,
      },
    };
    agent.send(JSON.stringify(screenshotEvent));

    await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.type === 'job.input_required' &&
      message.event.promptId === 'prompt_verify'
    ));

    const relayedScreenshot = await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.type === 'job.screenshot'
    ));
    assert(relayedScreenshot.event.image.width === 1440, 'screenshot width should be relayed');
    assert(relayedScreenshot.event.image.height === 900, 'screenshot height should be relayed');
    assert(relayedScreenshot.event.image.format === 'jpeg', 'screenshot format should be relayed');
    assert(relayedScreenshot.event.image.quality === 70, 'screenshot quality should be relayed');
    assert(relayedScreenshot.event.image.sourceId === 'screen:verify', 'screenshot sourceId should be relayed');
    assert(relayedScreenshot.event.image.bounds.x === 100, 'screenshot bounds should be relayed for click mapping');
    assert(relayedScreenshot.event.image.scaleFactor === 2, 'screenshot scale factor should be relayed');
    assert(
      typeof relayedScreenshot.event.imagePreview === 'string' &&
      relayedScreenshot.event.imagePreview.includes(Buffer.from('fake').toString('base64')),
      'live chat screenshot should include transient preview data',
    );

    const replayAfterScreenshot = await getJson(`${baseUrl}/api/events?after=0`);
    assert(
      !JSON.stringify(replayAfterScreenshot).includes(Buffer.from('fake').toString('base64')),
      'event replay should not persist screenshot image data',
    );
    assert(
      replayAfterScreenshot.events.some((event) => event.payload?.image?.bounds?.x === 100),
      'event replay should preserve non-sensitive screenshot geometry metadata',
    );

    const crossOwnerPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'other-user',
      chatId: 'prompt-chat',
      jobId: job.jobId,
      promptId: 'prompt_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(crossOwnerPromptResponse.ok === false, 'respond API should reject cross-owner prompt response');

    const crossChatPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'other-chat',
      jobId: job.jobId,
      promptId: 'prompt_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(crossChatPromptResponse.ok === false, 'respond API should reject cross-chat prompt response');

    const unknownPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'prompt-chat',
      jobId: job.jobId,
      promptId: 'prompt_missing_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(unknownPromptResponse.ok === false, 'respond API should reject unknown pending prompt response');

    const wrongJobPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'verify-chat',
      jobId: primaryTargetResponse.job.jobId,
      promptId: 'prompt_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(wrongJobPromptResponse.ok === false, 'respond API should reject prompt response for a different job');

    const response = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'prompt-chat',
      jobId: job.jobId,
      promptId: 'prompt_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(response.ok === true, 'response API should accept prompt response');

    const responseEvent = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.user_response' &&
      message.promptId === 'prompt_verify'
    ));
    assert(responseEvent.response.approved === true, 'agent should receive approved response');

    const duplicatePromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'prompt-chat',
      jobId: job.jobId,
      promptId: 'prompt_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(duplicatePromptResponse.ok === false, 'respond API should reject duplicate prompt response');

    agent.send(JSON.stringify({
      type: 'job.input_required',
      jobId: job.jobId,
      promptId: 'prompt_secret_verify',
      kind: 'secret',
      message: 'Enter verification secret',
    }));
    await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.promptId === 'prompt_secret_verify'
    ));
    const secretResponse = await postJson(`${baseUrl}/api/respond`, {
      jobId: job.jobId,
      promptId: 'prompt_secret_verify',
      response: { secret: 'super-secret-code' },
    });
    assert(secretResponse.ok === true, 'response API should accept secret response');
    const secretEvent = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.user_response' &&
      message.promptId === 'prompt_secret_verify'
    ));
    assert(secretEvent.response.secret === 'super-secret-code', 'agent should receive unredacted secret');
    const replayAfterSecret = await getJson(`${baseUrl}/api/events?after=0`);
    assert(
      !JSON.stringify(replayAfterSecret).includes('super-secret-code'),
      'event replay should not persist secret response values',
    );

    agent.send(JSON.stringify({
      type: 'job.input_required',
      jobId: job.jobId,
      promptId: 'prompt_cancel_cleanup_verify',
      kind: 'approval',
      message: 'Prompt should clear after cancellation',
    }));
    const stateWithCancelPrompt = await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=prompt-chat`, (candidate) => (
      candidate.pendingPrompts.some((prompt) => prompt.promptId === 'prompt_cancel_cleanup_verify')
    ));
    assert(
      stateWithCancelPrompt.pendingPrompts.some((prompt) => prompt.promptId === 'prompt_cancel_cleanup_verify'),
      'pending prompt should be visible before cancellation',
    );

    const state = await getJson(`${baseUrl}/api/state`);
    assert(Array.isArray(state.jobs), 'state API should include jobs');
    assert(state.jobs.some((stateJob) => stateJob.id === job.jobId), 'state API should include created job');

    const cancelResponse = await postJson(`${baseUrl}/api/jobs/${job.jobId}/cancel`, {
      reason: 'verify_cancel',
    });
    assert(cancelResponse.ok === true, 'cancel API should accept job cancellation');

    const cancelEvent = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.cancel' &&
      message.jobId === job.jobId
    ));
    assert(cancelEvent.reason === 'verify_cancel', 'agent should receive cancel reason');
    const stateAfterCancel = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=prompt-chat`);
    assert(
      !stateAfterCancel.pendingPrompts.some((prompt) => prompt.promptId === 'prompt_cancel_cleanup_verify'),
      'cancelling a job should clear pending prompts for that job',
    );
    const lateCancelPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'prompt-chat',
      jobId: job.jobId,
      promptId: 'prompt_cancel_cleanup_verify',
      response: { approved: true, scope: 'session' },
    });
    assert(lateCancelPromptResponse.ok === false, 'respond API should reject prompts cleared by cancellation');

    const terminalPromptJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      chatId: 'terminal-prompt-chat',
      deviceId: pairResponse.deviceId,
      command: 'ask Terminal cleanup?',
    });
    assert(terminalPromptJobResponse.ok === true, 'terminal prompt cleanup job should be accepted');
    const terminalPromptJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === terminalPromptJobResponse.job.jobId
    ));
    agent.send(JSON.stringify({
      type: 'job.input_required',
      jobId: terminalPromptJob.jobId,
      promptId: 'prompt_terminal_cleanup_verify',
      kind: 'text',
      message: 'Prompt should clear after terminal result',
    }));
    await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=terminal-prompt-chat`, (candidate) => (
      candidate.pendingPrompts.some((prompt) => prompt.promptId === 'prompt_terminal_cleanup_verify')
    ));
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: terminalPromptJob.jobId,
      status: 'failed',
      error: 'terminal cleanup verification',
    }));
    await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event?.type === 'job.result' &&
      message.event.jobId === terminalPromptJob.jobId
    ));
    const stateAfterTerminalResult = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user&chatId=terminal-prompt-chat`);
    assert(
      !stateAfterTerminalResult.pendingPrompts.some((prompt) => prompt.promptId === 'prompt_terminal_cleanup_verify'),
      'terminal job results should clear pending prompts for that job',
    );
    const lateTerminalPromptResponse = await postJson(`${baseUrl}/api/respond`, {
      ownerUserId: 'verify-user',
      chatId: 'terminal-prompt-chat',
      jobId: terminalPromptJob.jobId,
      promptId: 'prompt_terminal_cleanup_verify',
      response: { value: 'late response' },
    });
    assert(lateTerminalPromptResponse.ok === false, 'respond API should reject prompts cleared by terminal result');

    const streamJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'stream 2 1000',
    });
    assert(streamJobResponse.ok === true, 'job API should accept stream command');
    const streamJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.stream'
    ));
    assert(streamJob.args.durationMs === 2000, 'stream command should map seconds to durationMs');

    const jpegStreamJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'stream-jpeg 4 1500 62',
    });
    assert(jpegStreamJobResponse.ok === true, 'job API should accept stream-jpeg command');
    const jpegStreamJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.stream' &&
      message.args.format === 'jpeg'
    ));
    assert(
      jpegStreamJob.args.durationMs === 4000 &&
      jpegStreamJob.args.intervalMs === 1500 &&
      jpegStreamJob.args.quality === 62,
      'stream-jpeg command should relay duration, interval, and quality',
    );

    const sourceStreamJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'stream-source window:verify-source 3 1200 jpeg 64',
    });
    assert(sourceStreamJobResponse.ok === true, 'job API should accept stream-source command');
    const sourceStreamJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.stream' &&
      message.args.sourceId === 'window:verify-source'
    ));
    assert(
      sourceStreamJob.args.durationMs === 3000 &&
      sourceStreamJob.args.intervalMs === 1200 &&
      sourceStreamJob.args.format === 'jpeg' &&
      sourceStreamJob.args.quality === 64,
      'stream-source command should relay source, duration, interval, format, and quality',
    );

    const sourcesJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'sources',
    });
    assert(sourcesJobResponse.ok === true, 'job API should accept sources command');
    const sourcesJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.sources'
    ));
    assert(Object.keys(sourcesJob.args).length === 0, 'sources command should relay empty args');

    const windowsJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'windows',
    });
    assert(windowsJobResponse.ok === true, 'job API should accept windows command');
    const windowsJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.sources' &&
      message.args.includeWindows === true
    ));
    assert(windowsJob.args.includeWindows === true, 'windows command should include windows');
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: windowsJob.jobId,
      status: 'completed',
      result: {
        sources: [{
          id: 'screen:verify',
          name: 'Verify Display',
          type: 'screen',
          displayId: '1',
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
        }],
        count: 1,
      },
    }));
    const liveSourceResult = await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event?.type === 'job.result' &&
      message.event.jobId === windowsJob.jobId
    ));
    assert(
      liveSourceResult.event.result.sources[0].id === 'screen:verify',
      'live chat should receive screen source result for quick actions',
    );

    const jpegScreenshotJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'screenshot-jpeg 68 1024 768',
    });
    assert(jpegScreenshotJobResponse.ok === true, 'job API should accept screenshot-jpeg command');
    const jpegScreenshotJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.screenshot' &&
      message.args.format === 'jpeg'
    ));
    assert(
      jpegScreenshotJob.args.quality === 68 &&
      jpegScreenshotJob.args.width === 1024 &&
      jpegScreenshotJob.args.height === 768,
      'screenshot-jpeg command should relay quality and dimensions',
    );

    const sourceScreenshotJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'screenshot-source window:verify-source 1280 720 jpeg 66',
    });
    assert(sourceScreenshotJobResponse.ok === true, 'job API should accept screenshot-source command');
    const sourceScreenshotJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'screen.screenshot' &&
      message.args.sourceId === 'window:verify-source'
    ));
    assert(
      sourceScreenshotJob.args.width === 1280 &&
      sourceScreenshotJob.args.height === 720 &&
      sourceScreenshotJob.args.format === 'jpeg' &&
      sourceScreenshotJob.args.quality === 66,
      'screenshot-source command should relay source, thumbnail dimensions, format, and quality',
    );

    const clickJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'input.click',
      args: { x: 100, y: 200 },
      policy: { approvalMode: 'ask_every_time', timeoutMs: 5000, screenshotAfterAction: true },
    });
    assert(clickJobResponse.ok === true, 'structured job API should accept input.click');
    assert(
      clickJobResponse.job.policy.approvalMode === 'ask_every_time' &&
      clickJobResponse.job.policy.timeoutMs === 5000 &&
      clickJobResponse.job.policy.screenshotAfterAction === true,
      'structured job API should preserve valid policy fields',
    );
    const clickJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.click'
    ));
    assert(clickJob.args.x === 100 && clickJob.args.y === 200, 'input.click coordinates should relay');
    assert(clickJob.policy.timeoutMs === 5000, 'input.click policy should relay to the agent');
    assert(clickJob.policy.screenshotAfterAction === true, 'input.click screenshot-after-action policy should relay to the agent');

    const clickCommandResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'click 800 500 right 2',
    });
    assert(clickCommandResponse.ok === true, 'job API should accept click command');
    const clickCommandJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.click' &&
      message.args.button === 'right'
    ));
    assert(
      clickCommandJob.args.x === 800 &&
      clickCommandJob.args.y === 500 &&
      clickCommandJob.args.button === 'right' &&
      clickCommandJob.args.clickCount === 2,
      'click command should relay coordinate, button, and click count',
    );

    const clickInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'click-in Google Chrome :: 801 501 left 1',
    });
    assert(clickInResponse.ok === true, 'job API should accept click-in command');
    const clickInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.click' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(clickInJob.args.x === 801 && clickInJob.args.y === 501, 'click-in command should relay coordinates and expected app');

    const clickSnapResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'click-snap 810 510 left 1',
    });
    assert(clickSnapResponse.ok === true, 'job API should accept click-snap command');
    const clickSnapJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.click' &&
      message.args.x === 810 &&
      message.args.y === 510 &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(clickSnapJob.args.x === 810 && clickSnapJob.args.y === 510, 'click-snap command should relay coordinates');

    const clickSnapInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'click-snap-in Google Chrome :: 811 511 left 1',
    });
    assert(clickSnapInResponse.ok === true, 'job API should accept click-snap-in command');
    const clickSnapInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.click' &&
      message.args.expectedFrontmostApp === 'Google Chrome' &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(clickSnapInJob.args.x === 811 && clickSnapInJob.args.y === 511, 'click-snap-in command should relay coordinates, expected app, and snap policy');

    const dragResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'drag 10 20 30 40 350',
    });
    assert(dragResponse.ok === true, 'job API should accept drag command');
    const dragJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.drag'
    ));
    assert(
      dragJob.args.fromX === 10 &&
      dragJob.args.fromY === 20 &&
      dragJob.args.toX === 30 &&
      dragJob.args.toY === 40 &&
      dragJob.args.durationMs === 350,
      'drag command should relay coordinates and duration',
    );

    const dragInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'drag-in Google Chrome :: 11 21 31 41 351',
    });
    assert(dragInResponse.ok === true, 'job API should accept drag-in command');
    const dragInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.drag' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(dragInJob.args.durationMs === 351, 'drag-in command should relay duration and expected app');

    const dragSnapResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'drag-snap 10 20 30 40 350',
    });
    assert(dragSnapResponse.ok === true, 'job API should accept drag-snap command');
    const dragSnapJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.drag' &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(dragSnapJob.args.durationMs === 350, 'drag-snap command should relay duration');

    const dragSnapInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'drag-snap-in Google Chrome :: 12 22 32 42 352',
    });
    assert(dragSnapInResponse.ok === true, 'job API should accept drag-snap-in command');
    const dragSnapInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.drag' &&
      message.args.expectedFrontmostApp === 'Google Chrome' &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(dragSnapInJob.args.durationMs === 352, 'drag-snap-in command should relay duration, expected app, and snap policy');

    const scrollResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'scroll -900 0 800 500',
    });
    assert(scrollResponse.ok === true, 'job API should accept scroll command');
    const scrollJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.scroll'
    ));
    assert(
      scrollJob.args.deltaY === -900 &&
      scrollJob.args.deltaX === 0 &&
      scrollJob.args.x === 800 &&
      scrollJob.args.y === 500,
      'scroll command should relay deltas and optional coordinate',
    );

    const scrollInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'scroll-in Google Chrome :: -901 0 801 501',
    });
    assert(scrollInResponse.ok === true, 'job API should accept scroll-in command');
    const scrollInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.scroll' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(scrollInJob.args.deltaY === -901, 'scroll-in command should relay deltas and expected app');

    const scrollSnapResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'scroll-snap -900 0 800 500',
    });
    assert(scrollSnapResponse.ok === true, 'job API should accept scroll-snap command');
    const scrollSnapJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.scroll' &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(scrollSnapJob.args.deltaY === -900, 'scroll-snap command should relay deltas');

    const scrollSnapInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'scroll-snap-in Google Chrome :: -902 0 802 502',
    });
    assert(scrollSnapInResponse.ok === true, 'job API should accept scroll-snap-in command');
    const scrollSnapInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.scroll' &&
      message.args.expectedFrontmostApp === 'Google Chrome' &&
      message.policy?.screenshotAfterAction === true
    ));
    assert(scrollSnapInJob.args.deltaY === -902, 'scroll-snap-in command should relay deltas, expected app, and snap policy');

    const pressResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'press return shift',
    });
    assert(pressResponse.ok === true, 'job API should accept press command');
    const pressJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.press_key'
    ));
    assert(
      pressJob.args.key === 'return' &&
      pressJob.args.modifiers?.[0] === 'shift',
      'press command should relay key and modifiers',
    );

    const typeInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'type-in Google Chrome :: guarded text',
    });
    assert(typeInResponse.ok === true, 'job API should accept type-in command');
    const typeInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.type_text' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(typeInJob.args.text === 'guarded text', 'type-in command should relay text and expected app');

    const hotkeyInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'hotkey-in Google Chrome :: l command',
    });
    assert(hotkeyInResponse.ok === true, 'job API should accept hotkey-in command');
    const hotkeyInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.hotkey' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(
      hotkeyInJob.args.key === 'l' &&
      hotkeyInJob.args.modifiers?.[0] === 'command',
      'hotkey-in command should relay key, modifiers, and expected app',
    );

    const pressInResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'press-in Google Chrome :: return',
    });
    assert(pressInResponse.ok === true, 'job API should accept press-in command');
    const pressInJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'input.press_key' &&
      message.args.expectedFrontmostApp === 'Google Chrome'
    ));
    assert(pressInJob.args.key === 'return', 'press-in command should relay key and expected app');

    const appsListResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'apps',
    });
    assert(appsListResponse.ok === true, 'job API should accept apps command');
    const appsListJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'apps.list'
    ));
    assert(
      Object.keys(appsListJob.args).length === 0,
      'apps command should relay empty args',
    );

    const frontmostResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'frontmost',
    });
    assert(frontmostResponse.ok === true, 'job API should accept frontmost command');
    const frontmostJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'apps.frontmost'
    ));
    assert(
      Object.keys(frontmostJob.args).length === 0,
      'frontmost command should relay empty args',
    );

    const appActivateResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'activate-app Google Chrome',
    });
    assert(appActivateResponse.ok === true, 'job API should accept activate-app command');
    const appActivateJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'apps.activate'
    ));
    assert(appActivateJob.args.name === 'Google Chrome', 'activate-app command should relay app name');

    const appQuitResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'quit-app TextEdit',
    });
    assert(appQuitResponse.ok === true, 'job API should accept quit-app command');
    const appQuitJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'apps.quit'
    ));
    assert(appQuitJob.args.name === 'TextEdit', 'quit-app command should relay app name');

    const sysinfoResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'sysinfo',
    });
    assert(sysinfoResponse.ok === true, 'job API should accept sysinfo command');
    const sysinfoJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'system.info'
    ));
    assert(Object.keys(sysinfoJob.args).length === 0, 'sysinfo command should relay empty args');

    const storageResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'storage /tmp',
    });
    assert(storageResponse.ok === true, 'job API should accept storage command');
    const storageJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'system.storage'
    ));
    assert(storageJob.args.path === '/tmp', 'storage command should relay path');

    const networkResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'network',
    });
    assert(networkResponse.ok === true, 'job API should accept network command');
    const networkJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'system.network'
    ));
    assert(Object.keys(networkJob.args).length === 0, 'network command should relay empty args');

    const networkAllResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'network-all',
    });
    assert(networkAllResponse.ok === true, 'job API should accept network-all command');
    const networkAllJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'system.network' &&
      message.args.includeInternal === true
    ));
    assert(networkAllJob.args.includeInternal === true, 'network-all command should include internal interfaces');

    const clipboardReadResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'clip-read',
    });
    assert(clipboardReadResponse.ok === true, 'job API should accept clip-read command');
    const clipboardReadJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'clipboard.read_text'
    ));
    assert(
      Object.keys(clipboardReadJob.args).length === 0,
      'clip-read command should relay empty args',
    );

    const clipboardWriteResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'clip-write clipboard-secret-text',
    });
    assert(clipboardWriteResponse.ok === true, 'job API should accept clip-write command');
    const clipboardWriteJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'clipboard.write_text'
    ));
    assert(
      clipboardWriteJob.args.text === 'clipboard-secret-text',
      'clip-write command should relay text only to the agent',
    );
    const jobsAfterClipboardWrite = await getJson(`${baseUrl}/api/jobs`);
    assert(
      !JSON.stringify(jobsAfterClipboardWrite).includes('clipboard-secret-text'),
      'jobs API should not expose clipboard write text',
    );

    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: clipboardReadJob.jobId,
      status: 'completed',
      result: {
        content: 'clipboard-read-secret-text',
        bytes: 26,
      },
    }));
    await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.type === 'job.result' &&
      message.event.jobId === clipboardReadJob.jobId
    ));
    const stateAfterClipboardRead = await getJson(`${baseUrl}/api/state`);
    assert(
      !JSON.stringify(stateAfterClipboardRead).includes('clipboard-read-secret-text'),
      'state API should not expose clipboard read text',
    );
    const replayAfterClipboardRead = await getJson(`${baseUrl}/api/events?after=0`);
    assert(
      !JSON.stringify(replayAfterClipboardRead).includes('clipboard-read-secret-text'),
      'event replay should not expose clipboard read text',
    );

    const unknownToolResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'desktop.unsupported',
      args: {},
    });
    assert(unknownToolResponse.ok === false, 'structured job API should reject unknown tools');
    assert(
      String(unknownToolResponse.error).includes('Unknown desktop tool'),
      'unknown tool rejection should explain the tool validation failure',
    );

    const badArgsResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'input.click',
      args: '100,200',
    });
    assert(badArgsResponse.ok === false, 'structured job API should reject non-object args');
    assert(
      String(badArgsResponse.error).includes('args must be an object'),
      'bad args rejection should explain the args validation failure',
    );

    const badPolicyResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'agent.ask_user',
      args: { message: 'verify' },
      policy: { approvalMode: 'forever', timeoutMs: 5000 },
    });
    assert(badPolicyResponse.ok === false, 'structured job API should reject invalid policy');
    assert(
      String(badPolicyResponse.error).includes('approvalMode'),
      'bad policy rejection should explain the policy validation failure',
    );

    const unknownPolicyFieldResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'agent.ask_user',
      args: { message: 'verify' },
      policy: { approvalMode: 'session', timeoutMs: 5000, priority: 'urgent' },
    });
    assert(
      unknownPolicyFieldResponse.ok === false,
      'structured job API should reject unsupported policy fields',
    );
    assert(
      String(unknownPolicyFieldResponse.error).includes('unsupported field'),
      'unsupported policy field rejection should explain the policy validation failure',
    );

    const badScreenshotPolicyResponse = await postJson(`${baseUrl}/api/jobs`, {
      tool: 'agent.ask_user',
      args: { message: 'verify' },
      policy: { screenshotAfterAction: 'yes' },
    });
    assert(
      badScreenshotPolicyResponse.ok === false,
      'structured job API should reject non-boolean screenshotAfterAction policy',
    );
    assert(
      String(badScreenshotPolicyResponse.error).includes('screenshotAfterAction'),
      'bad screenshotAfterAction policy rejection should explain the policy validation failure',
    );

    const appleScriptJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'applescript return "verify"',
    });
    assert(appleScriptJobResponse.ok === true, 'job API should accept applescript command');
    const appleScriptJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'automation.applescript'
    ));
    assert(appleScriptJob.args.script === 'return "verify"', 'applescript command should relay script text');

    const secretSaveJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'secret-save verify-login :: one-time-password',
    });
    assert(secretSaveJobResponse.ok === true, 'job API should accept secret-save command');
    const secretSaveJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'secrets.save'
    ));
    assert(secretSaveJob.args.name === 'verify-login', 'secret-save command should relay secret name');
    assert(secretSaveJob.args.secret === 'one-time-password', 'secret-save command should relay secret only to the agent');
    const jobsAfterSecretSave = await getJson(`${baseUrl}/api/jobs`);
    assert(
      !JSON.stringify(jobsAfterSecretSave).includes('one-time-password'),
      'jobs API should not expose saved secret values',
    );

    const secretExistsJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'secret-exists verify-login',
    });
    assert(secretExistsJobResponse.ok === true, 'job API should accept secret-exists command');
    const secretExistsJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'secrets.exists'
    ));
    assert(secretExistsJob.args.name === 'verify-login', 'secret-exists command should relay secret name');

    const secretFillJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'secret-fill verify-login',
    });
    assert(secretFillJobResponse.ok === true, 'job API should accept secret-fill command');
    const secretFillJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'secrets.fill_focused_field'
    ));
    assert(secretFillJob.args.name === 'verify-login', 'secret-fill command should relay secret name');

    const secretDeleteJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'secret-delete verify-login',
    });
    assert(secretDeleteJobResponse.ok === true, 'job API should accept secret-delete command');
    const secretDeleteJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'secrets.delete'
    ));
    assert(secretDeleteJob.args.name === 'verify-login', 'secret-delete command should relay secret name');

    const statJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'stat /tmp/example.txt',
    });
    assert(statJobResponse.ok === true, 'job API should accept stat command');
    const statJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.stat'
    ));
    assert(statJob.args.path === '/tmp/example.txt', 'stat command should relay path');

    const downloadJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'download /tmp/example.bin',
    });
    assert(downloadJobResponse.ok === true, 'job API should accept download command');
    const downloadJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.read_binary'
    ));
    assert(downloadJob.args.path === '/tmp/example.bin', 'download command should relay path');

    const tailJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'tail /tmp/example.log :: 25',
    });
    assert(tailJobResponse.ok === true, 'job API should accept tail command');
    const tailJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.tail'
    ));
    assert(tailJob.args.path === '/tmp/example.log', 'tail command should relay path');
    assert(tailJob.args.lines === 25, 'tail command should relay line count');

    const watchJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'watch /tmp/example-folder :: 3 :: 1000',
    });
    assert(watchJobResponse.ok === true, 'job API should accept watch command');
    const watchJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.watch'
    ));
    assert(watchJob.args.path === '/tmp/example-folder', 'watch command should relay path');
    assert(watchJob.args.durationMs === 3000, 'watch command should relay duration');
    assert(watchJob.args.intervalMs === 1000, 'watch command should relay interval');

    const uploadJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'upload /tmp/example.bin :: dmVyaWZ5',
    });
    assert(uploadJobResponse.ok === true, 'job API should accept upload command');
    const uploadJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.write_binary'
    ));
    assert(uploadJob.args.path === '/tmp/example.bin', 'upload command should relay path');
    assert(uploadJob.args.contentBase64 === 'dmVyaWZ5', 'upload command should relay base64 content');

    const mkdirJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'mkdir /tmp/ci-managed',
    });
    assert(mkdirJobResponse.ok === true, 'job API should accept mkdir command');
    const mkdirJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.mkdir'
    ));
    assert(mkdirJob.args.path === '/tmp/ci-managed', 'mkdir command should relay path');

    const copyJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'copy /tmp/source.txt :: /tmp/destination.txt',
    });
    assert(copyJobResponse.ok === true, 'job API should accept copy command');
    const copyJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.copy'
    ));
    assert(copyJob.args.sourcePath === '/tmp/source.txt', 'copy command should relay source path');
    assert(copyJob.args.destinationPath === '/tmp/destination.txt', 'copy command should relay destination path');

    const moveJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'move /tmp/destination.txt :: /tmp/moved.txt',
    });
    assert(moveJobResponse.ok === true, 'job API should accept move command');
    const moveJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.move'
    ));
    assert(moveJob.args.sourcePath === '/tmp/destination.txt', 'move command should relay source path');
    assert(moveJob.args.destinationPath === '/tmp/moved.txt', 'move command should relay destination path');

    const deleteJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'delete-recursive /tmp/ci-managed',
    });
    assert(deleteJobResponse.ok === true, 'job API should accept delete-recursive command');
    const deleteJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.delete'
    ));
    assert(deleteJob.args.path === '/tmp/ci-managed', 'delete command should relay path');
    assert(deleteJob.args.recursive === true, 'delete-recursive command should set recursive flag');

    const fileOpenJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'file-open /tmp/example.txt',
    });
    assert(fileOpenJobResponse.ok === true, 'job API should accept file-open command');
    const fileOpenJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.open'
    ));
    assert(fileOpenJob.args.path === '/tmp/example.txt', 'file-open command should relay path');

    const revealJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      command: 'reveal /tmp/example.txt',
    });
    assert(revealJobResponse.ok === true, 'job API should accept reveal command');
    const revealJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.tool === 'files.reveal'
    ));
    assert(revealJob.args.path === '/tmp/example.txt', 'reveal command should relay path');

    const jobsAfterUpload = await getJson(`${baseUrl}/api/jobs`);
    assert(
      !JSON.stringify(jobsAfterUpload).includes('dmVyaWZ5'),
      'jobs API should not expose uploaded base64 content',
    );

    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: tailJob.jobId,
      status: 'completed',
      result: {
        path: '/tmp/example.log',
        size: 22,
        encoding: 'utf-8',
        content: 'downloaded-secret-text',
        truncated: false,
      },
    }));
    const liveTextPreview = await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.type === 'job.result' &&
      message.event.jobId === tailJob.jobId &&
      message.event.filePreview?.kind === 'text'
    ));
    assert(
      liveTextPreview.event.filePreview?.kind === 'text' &&
      liveTextPreview.event.filePreview.content === 'downloaded-secret-text',
      'live chat should receive transient text file preview',
    );

    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: downloadJob.jobId,
      status: 'completed',
      result: {
        path: '/tmp/example.bin',
        size: 17,
        encoding: 'base64',
        contentBase64: 'ZG93bmxvYWRlZC1zZWNyZXQ=',
      },
    }));
    const liveBinaryPreview = await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event &&
      message.event.type === 'job.result' &&
      message.event.jobId === downloadJob.jobId &&
      message.event.filePreview?.kind === 'binary'
    ));
    assert(
      liveBinaryPreview.event.filePreview?.kind === 'binary' &&
      liveBinaryPreview.event.filePreview.contentBase64 === 'ZG93bmxvYWRlZC1zZWNyZXQ=' &&
      liveBinaryPreview.event.filePreview.dataUrl.includes('ZG93bmxvYWRlZC1zZWNyZXQ='),
      'live chat should receive transient binary file download preview',
    );

    const invalidBinaryResultResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'download /tmp/invalid-result.bin',
    });
    assert(invalidBinaryResultResponse.ok === true, 'invalid binary result job should be accepted');
    const invalidBinaryResultJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === invalidBinaryResultResponse.job.jobId &&
      message.tool === 'files.read_binary'
    ));
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: invalidBinaryResultJob.jobId,
      status: 'completed',
      result: {
        path: '/tmp/invalid-result.bin',
        size: 4,
        encoding: 'base64',
        contentBase64: 'dmVyeQ==',
        data: 'raw-base64-result',
      },
    }));
    await waitForState(`${baseUrl}/api/state?ownerUserId=verify-user`, (state) => (
      state.events.some((event) => (
        event.type === 'agent.event.rejected' &&
        event.jobId === invalidBinaryResultJob.jobId &&
        event.payload?.reason === 'invalid_result' &&
        String(event.payload?.error || '').includes('result.data is not allowed')
      ))
    ));

    const stateAfterSensitiveResult = await getJson(`${baseUrl}/api/state`);
    const stateJson = JSON.stringify(stateAfterSensitiveResult);
    assert(!stateJson.includes('downloaded-secret-text'), 'state API should not expose file text content');
    assert(!stateJson.includes('ZG93bmxvYWRlZC1zZWNyZXQ='), 'state API should not expose file base64 content');
    assert(!stateJson.includes('raw-base64-result'), 'state API should not expose raw data payloads');
    const replayAfterSensitiveResult = await getJson(`${baseUrl}/api/events?after=0`);
    const replaySensitiveJson = JSON.stringify(replayAfterSensitiveResult);
    assert(!replaySensitiveJson.includes('downloaded-secret-text'), 'event replay should not expose file text preview');
    assert(!replaySensitiveJson.includes('ZG93bmxvYWRlZC1zZWNyZXQ='), 'event replay should not expose binary file preview');

    const largeReadJobResponse = await postJson(`${baseUrl}/api/jobs`, {
      ownerUserId: 'verify-user',
      deviceId: pairResponse.deviceId,
      command: 'read /tmp/large-preview.txt',
    });
    assert(largeReadJobResponse.ok === true, 'large preview job should be accepted');
    const largeReadJob = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === largeReadJobResponse.job.jobId &&
      message.tool === 'files.read'
    ));
    const largeContent = `large-preview-start-${'x'.repeat(130 * 1024)}-large-preview-end`;
    agent.send(JSON.stringify({
      type: 'job.result',
      jobId: largeReadJob.jobId,
      status: 'completed',
      result: {
        path: '/tmp/large-preview.txt',
        size: largeContent.length,
        encoding: 'utf-8',
        content: largeContent,
      },
    }));
    const largePreview = await waitForMessage(chatMessages, (message) => (
      message.direction === 'agent' &&
      message.event?.type === 'job.result' &&
      message.event.jobId === largeReadJob.jobId &&
      message.event.filePreview?.kind === 'text'
    ));
    assert(
      largePreview.event.filePreview.truncated === true &&
      largePreview.event.filePreview.content.length <= 100 * 1024 &&
      largePreview.event.filePreview.content.includes('large-preview-start') &&
      !largePreview.event.filePreview.content.includes('large-preview-end'),
      'live text file previews should be capped and marked truncated',
    );
    const stateAfterLargePreview = await getJson(`${baseUrl}/api/state?ownerUserId=verify-user`);
    const stateAfterLargePreviewJson = JSON.stringify(stateAfterLargePreview);
    assert(
      !stateAfterLargePreviewJson.includes('large-preview-start') &&
      !stateAfterLargePreviewJson.includes('large-preview-end'),
      'state API should not expose oversized file preview content',
    );

    const unauthenticatedRevokeResponse = await postJson(`${baseUrl}/api/desktop/devices/${pairResponse.deviceId}/revoke`, {});
    assert(
      unauthenticatedRevokeResponse.ok === false &&
      /bearer token/i.test(String(unauthenticatedRevokeResponse.error || '')),
      'revoke API should require a device bearer token',
    );
    assert(
      agent.readyState === WebSocket.OPEN,
      'unauthenticated revoke should not close the paired device socket',
    );

    const wrongTokenRevokeResponse = await postJson(`${baseUrl}/api/desktop/devices/${pairResponse.deviceId}/revoke`, {}, {
      authorization: 'Bearer wrong-device-token',
    });
    assert(
      wrongTokenRevokeResponse.ok === false &&
      /bearer token/i.test(String(wrongTokenRevokeResponse.error || '')),
      'revoke API should reject an invalid device bearer token',
    );
    assert(
      agent.readyState === WebSocket.OPEN,
      'invalid-token revoke should not close the paired device socket',
    );

    const revokeResponse = await postJson(`${baseUrl}/api/desktop/devices/${pairResponse.deviceId}/revoke`, {}, {
      authorization: `Bearer ${pairResponse.deviceToken}`,
    });
    assert(revokeResponse.ok === true, 'revoke API should accept device revocation');
    await waitForSocketClose(agent);

    const revokedState = await getJson(`${baseUrl}/api/state`);
    assert(
      revokedState.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.status === 'revoked'
      )),
      'revoked device should remain revoked in state',
    );

    await assertSocketRejected(agentUrl, {
      headers: {
        authorization: `Bearer ${pairResponse.deviceToken}`,
      },
    });

    agent.close();
    secondAgent.close();
    chat.close();
    resumedChat.close();
    eventIdChat.close();
    console.log('Mock gateway protocol verification passed');
  } finally {
    gateway.kill('SIGTERM');
    setTimeout(() => {
      if (!gateway.killed) gateway.kill('SIGKILL');
    }, 1000).unref();
  }
}

async function verifyPersistedState() {
  const persistPort = port + 1;
  const persistBaseUrl = `http://127.0.0.1:${persistPort}`;
  const persistAgentUrl = `ws://127.0.0.1:${persistPort}/desktop-agent/connect`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-gateway-state-'));
  const statePath = path.join(tmpDir, 'state.json');
  let gateway = null;

  try {
    gateway = spawnGateway(persistPort, statePath);
    await waitForHttp(`${persistBaseUrl}/`, 5000);

    const pairResponse = await postJson(`${persistBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'persist-user',
      displayName: 'Persist Mac',
    });
    const queuedJobResponse = await postJson(`${persistBaseUrl}/api/jobs`, {
      command: 'open https://persisted.example',
    });
    assert(pairResponse.deviceToken, 'persist pair should return token');
    assert(queuedJobResponse.ok === true, 'persist queued job should be accepted');
    const initialEvents = await getJson(`${persistBaseUrl}/api/events?after=0`);
    assert(initialEvents.events.length >= 2, 'event replay should include persisted pair/job events');
    assert(initialEvents.lastSeq >= initialEvents.events.length, 'event replay should include lastSeq');
    const lastSeqBeforeRestart = initialEvents.lastSeq;
    const persistedBeforeRestart = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const persistedBeforeRestartJson = JSON.stringify(persistedBeforeRestart);
    assert(
      !persistedBeforeRestartJson.includes(pairResponse.deviceToken),
      'persisted mock gateway state should not contain plaintext device token',
    );
    assert(
      persistedBeforeRestart.deviceTokens.every(([token]) => token.startsWith('sha256:')),
      'persisted mock gateway token lookup should store token hashes',
    );
    assert(
      !persistedBeforeRestart.devices.some((device) => 'deviceTokenHash' in device),
      'persisted device records should not duplicate token hashes used for job signing',
    );

    await stopGateway(gateway);
    gateway = spawnGateway(persistPort, statePath);
    await waitForHttp(`${persistBaseUrl}/`, 5000);

    const restoredState = await getJson(`${persistBaseUrl}/api/state`);
    assert(
      restoredState.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.status === 'offline'
      )),
      'persisted device should restore as offline',
    );
    assert(
      !JSON.stringify(restoredState).includes('deviceTokenHash'),
      'restored state should not expose job signing token hashes',
    );
    assert(
      restoredState.jobs.some((job) => (
        job.id === queuedJobResponse.job.jobId &&
        job.status === 'queued'
      )),
      'persisted queued job should restore as queued',
    );
    const restoredEvents = await getJson(`${persistBaseUrl}/api/events?after=0`);
    assert(
      restoredEvents.events.some((event) => event.type === 'device.paired'),
      'persisted events should replay after restart',
    );
    assert(restoredEvents.lastSeq === lastSeqBeforeRestart, 'event sequence should persist across restart');

    const agent = await openSocket(persistAgentUrl, {
      headers: {
        authorization: `Bearer ${pairResponse.deviceToken}`,
      },
    });
    const agentMessages = collectMessages(agent);
    agent.send(JSON.stringify({
      type: 'hello',
      deviceId: pairResponse.deviceId,
      displayName: 'Persist Mac',
      agentVersion: 'verify',
      capabilities: ['browser.open_url'],
    }));
    const delivered = await waitForMessage(agentMessages, (message) => (
      message.type === 'job.start' &&
      message.jobId === queuedJobResponse.job.jobId
    ));
    assert(delivered.args.url === 'https://persisted.example', 'persisted queued job should replay after restart');
    assert(
      delivered.signature?.algorithm === 'hmac-sha256',
      'persisted queued job should be signed after restart',
    );
    const eventsAfterDelivery = await getJson(`${persistBaseUrl}/api/events?after=${lastSeqBeforeRestart}`);
    assert(
      eventsAfterDelivery.events.some((event) => event.type === 'job.delivered'),
      'event replay should return events after cursor',
    );
    agent.close();
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function verifyHeartbeatTimeout() {
  const heartbeatPort = port + 2;
  const heartbeatBaseUrl = `http://127.0.0.1:${heartbeatPort}`;
  const heartbeatAgentUrl = `ws://127.0.0.1:${heartbeatPort}/desktop-agent/connect`;
  let gateway = null;
  let agent = null;

  try {
    gateway = spawnGateway(heartbeatPort, '', {
      CI_DESKTOP_AGENT_OFFLINE_TIMEOUT_MS: '1000',
    });
    await waitForHttp(`${heartbeatBaseUrl}/`, 5000);

    const pairResponse = await postJson(`${heartbeatBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'heartbeat-user',
      displayName: 'Heartbeat Mac',
    });

    agent = await openSocket(heartbeatAgentUrl, {
      headers: {
        authorization: `Bearer ${pairResponse.deviceToken}`,
      },
    });
    agent.send(JSON.stringify({
      type: 'hello',
      deviceId: pairResponse.deviceId,
      displayName: 'Heartbeat Mac',
      agentVersion: 'verify',
      capabilities: [],
    }));

    await waitForState(`${heartbeatBaseUrl}/api/state?ownerUserId=heartbeat-user`, (state) => (
      state.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.status === 'online'
      ))
    ));

    const offlineState = await waitForState(`${heartbeatBaseUrl}/api/state?ownerUserId=heartbeat-user`, (state) => (
      state.devices.some((device) => (
        device.id === pairResponse.deviceId &&
        device.status === 'offline' &&
        device.offlineReason === 'heartbeat_timeout'
      ))
    ), 5000);
    assert(
      offlineState.events.some((event) => event.type === 'device.offline'),
      'heartbeat timeout should append a device.offline event',
    );
  } finally {
    if (agent) agent.close();
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

async function verifyOwnerAllowlist() {
  const ownerPort = port + 3;
  const ownerBaseUrl = `http://127.0.0.1:${ownerPort}`;
  let gateway = null;

  try {
    gateway = spawnGateway(ownerPort, '', {
      CI_DESKTOP_AGENT_ALLOWED_OWNER_USER_ID: 'allowed-owner',
    });
    await waitForHttp(`${ownerBaseUrl}/`, 5000);

    const chatPage = await getText(`${ownerBaseUrl}/`);
    assert(
      chatPage.includes('value="allowed-owner"') &&
      chatPage.includes('const defaultOwner = "allowed-owner"'),
      'mock chat should default to the configured personal owner',
    );

    const rejectedPair = await postJson(`${ownerBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'other-owner',
      displayName: 'Other Mac',
    });
    assert(
      String(rejectedPair.error || '').includes('not allowed'),
      'personal owner lock should reject pairing for another owner',
    );

    const pairResponse = await postJson(`${ownerBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'allowed-owner',
      displayName: 'Allowed Mac',
    });
    assert(pairResponse.deviceToken, 'personal owner lock should allow pairing for the configured owner');

    const rejectedJob = await postJson(`${ownerBaseUrl}/api/jobs`, {
      ownerUserId: 'other-owner',
      command: 'open https://blocked-owner.example',
    });
    assert(
      rejectedJob.ok === false &&
      String(rejectedJob.error || '').includes('not allowed'),
      'personal owner lock should reject jobs for another owner',
    );

    const defaultOwnerJob = await postJson(`${ownerBaseUrl}/api/jobs`, {
      command: 'open https://allowed-owner.example',
    });
    assert(
      defaultOwnerJob.ok === true &&
      defaultOwnerJob.ownerUserId === 'allowed-owner',
      'personal owner lock should use the configured owner for unscoped local mock jobs',
    );
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

async function verifyStrictDeviceTargeting() {
  const strictPort = port + 4;
  const strictBaseUrl = `http://127.0.0.1:${strictPort}`;
  let gateway = null;

  try {
    gateway = spawnGateway(strictPort, '', {
      CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE: '1',
    });
    await waitForHttp(`${strictBaseUrl}/`, 5000);

    const firstPair = await postJson(`${strictBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'strict-user',
      displayName: 'Strict Primary Mac',
    });
    assert(firstPair.deviceId, 'strict device targeting should pair the first device');

    const singleDeviceJob = await postJson(`${strictBaseUrl}/api/jobs`, {
      ownerUserId: 'strict-user',
      command: 'open https://single-device.example',
    });
    assert(
      singleDeviceJob.ok === true &&
      singleDeviceJob.deviceId === firstPair.deviceId,
      'strict device targeting should still auto-route when the owner has one device',
    );

    const secondPair = await postJson(`${strictBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'strict-user',
      displayName: 'Strict Secondary Mac',
    });
    assert(secondPair.deviceId, 'strict device targeting should pair the second device');

    const ambiguousJob = await postJson(`${strictBaseUrl}/api/jobs`, {
      ownerUserId: 'strict-user',
      command: 'open https://ambiguous-device.example',
    });
    assert(
      ambiguousJob.ok === false &&
      /Multiple devices/.test(String(ambiguousJob.error || '')) &&
      /specify deviceId/.test(String(ambiguousJob.error || '')),
      'strict device targeting should reject owner jobs that omit deviceId when multiple devices exist',
    );

    const targetedJob = await postJson(`${strictBaseUrl}/api/jobs`, {
      ownerUserId: 'strict-user',
      deviceId: secondPair.deviceId,
      command: 'open https://targeted-device.example',
    });
    assert(
      targetedJob.ok === true &&
      targetedJob.deviceId === secondPair.deviceId,
      'strict device targeting should accept an explicit target device',
    );
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

async function verifyPairingTokenRequirement() {
  const pairingPort = port + 5;
  const pairingBaseUrl = `http://127.0.0.1:${pairingPort}`;
  let gateway = null;

  try {
    gateway = spawnGateway(pairingPort, '', {
      CI_DESKTOP_AGENT_REQUIRE_PAIRING_TOKEN: '1',
    });
    await waitForHttp(`${pairingBaseUrl}/`, 5000);

    const missingTokenPair = await postJson(`${pairingBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'pair-token-user',
      displayName: 'Pair Token Mac',
    });
    assert(
      missingTokenPair.ok === false &&
      /Pairing bearer token is required/.test(String(missingTokenPair.error || '')),
      'mock gateway should reject pairing without a required pairing bearer token',
    );

    const tokenPair = await postJson(`${pairingBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'pair-token-user',
      displayName: 'Pair Token Mac',
    }, {
      authorization: 'Bearer short-lived-pairing-token',
    });
    assert(
      tokenPair.deviceId &&
      tokenPair.deviceToken &&
      tokenPair.ownerUserId === 'pair-token-user',
      'mock gateway should allow pairing with a required pairing bearer token',
    );
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

async function verifyChatApiTokenRequirement() {
  const chatAuthPort = port + 6;
  const chatAuthBaseUrl = `http://127.0.0.1:${chatAuthPort}`;
  const chatAuthUrl = `ws://127.0.0.1:${chatAuthPort}/chat`;
  let gateway = null;

  try {
    gateway = spawnGateway(chatAuthPort, '', {
      CI_DESKTOP_AGENT_CHAT_API_TOKEN: 'mock-chat-api-token',
    });
    await waitForHttp(`${chatAuthBaseUrl}/`, 5000);

    const unauthorizedState = await getJson(`${chatAuthBaseUrl}/api/state`);
    assert(
      unauthorizedState.ok === false &&
      /bearer token/.test(String(unauthorizedState.error || '')),
      'mock chat state API should reject requests without the configured chat API token',
    );

    const authorizedState = await getJson(`${chatAuthBaseUrl}/api/state`, {
      authorization: 'Bearer mock-chat-api-token',
    });
    assert(Array.isArray(authorizedState.devices), 'mock chat state API should accept a valid chat API token');

    const unauthorizedJob = await postJson(`${chatAuthBaseUrl}/api/jobs`, {
      ownerUserId: 'chat-auth-user',
      command: 'open https://blocked-chat-auth.example',
    });
    assert(
      unauthorizedJob.ok === false &&
      /bearer token/.test(String(unauthorizedJob.error || '')),
      'mock chat job API should reject requests without the configured chat API token',
    );

    const authorizedJob = await postJson(`${chatAuthBaseUrl}/api/jobs`, {
      ownerUserId: 'chat-auth-user',
      command: 'open https://allowed-chat-auth.example',
    }, {
      authorization: 'Bearer mock-chat-api-token',
    });
    assert(authorizedJob.ok === true, 'mock chat job API should accept a valid chat API token');

    await assertSocketRejected(chatAuthUrl);
    const authorizedChat = await openSocket(`${chatAuthUrl}?chatToken=mock-chat-api-token`);
    authorizedChat.close();
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

async function verifyReplayRetentionMetadata() {
  const retentionPort = port + 7;
  const retentionBaseUrl = `http://127.0.0.1:${retentionPort}`;
  let gateway = null;

  try {
    gateway = spawnGateway(retentionPort, '', {
      CI_DESKTOP_AGENT_MAX_EVENTS: '3',
    });
    await waitForHttp(`${retentionBaseUrl}/`, 5000);

    const pairResponse = await postJson(`${retentionBaseUrl}/api/desktop/devices/pair`, {
      ownerUserId: 'retention-user',
      displayName: 'Retention Mac',
    });
    assert(pairResponse.deviceId, 'retention gateway should pair a device');

    for (let index = 0; index < 5; index += 1) {
      const jobResponse = await postJson(`${retentionBaseUrl}/api/jobs`, {
        ownerUserId: 'retention-user',
        deviceId: pairResponse.deviceId,
        command: `open https://retention-${index}.example`,
      });
      assert(jobResponse.ok === true, `retention job ${index} should be accepted`);
    }

    const replay = await getJson(`${retentionBaseUrl}/api/events?after=0&ownerUserId=retention-user`);
    assert(replay.maxRetainedEvents === 3, 'event replay should report configured retention limit');
    assert(replay.retainedEventCount === 3, 'event replay should return only retained events');
    assert(replay.firstSeq > 1, 'event replay should report the first retained sequence');
    assert(replay.replayTruncated === true, 'event replay should mark stale cursors as truncated');

    const currentReplay = await getJson(`${retentionBaseUrl}/api/events?after=${replay.lastSeq}&ownerUserId=retention-user`);
    assert(currentReplay.replayTruncated === false, 'event replay should not mark current cursors as truncated');
  } finally {
    if (gateway) await stopGateway(gateway).catch(() => undefined);
  }
}

function spawnGateway(gatewayPort, statePath, extraEnv = {}) {
  return spawn(process.execPath, ['scripts/mock-agent-gateway.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI_DESKTOP_AGENT_MOCK_PORT: String(gatewayPort),
      CI_DESKTOP_AGENT_REQUIRE_TOKEN: '1',
      CI_DESKTOP_AGENT_STATE_PATH: statePath,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stopGateway(gateway) {
  return new Promise((resolve) => {
    if (!gateway || gateway.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      gateway.kill('SIGKILL');
      resolve();
    }, 1500);
    timer.unref();
    gateway.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    gateway.kill('SIGTERM');
  });
}

function waitForSocketClose(socket, timeoutMs = 5000) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for socket close'));
    }, timeoutMs);

    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertSocketRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let opened = false;
    socket.once('open', () => {
      opened = true;
      socket.close();
      reject(new Error('Expected socket connection to be rejected'));
    });
    socket.once('error', () => {
      if (!opened) resolve();
    });
    socket.once('close', () => {
      if (!opened) resolve();
    });
    setTimeout(() => {
      if (!opened && socket.readyState !== WebSocket.OPEN) {
        resolve();
      }
    }, 500);
  });
}

function getJson(url, headers = {}) {
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function getText(url) {
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function openSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function collectMessages(socket) {
  const messages = [];
  socket.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push({ type: 'raw', value: raw.toString() });
    }
  });
  return messages;
}

async function waitForMessage(messages, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = messages.find(predicate);
    if (match) return match;
    await sleep(50);
  }
  throw new Error('Timed out waiting for matching WebSocket message');
}

async function assertNoMessage(messages, predicate, message, timeoutMs = 300) {
  await sleep(timeoutMs);
  if (messages.some(predicate)) {
    throw new Error(message);
  }
}

async function waitForState(url, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await getJson(url);
    if (predicate(state)) return state;
    await sleep(50);
  }
  throw new Error('Timed out waiting for matching state');
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      }).on('error', retry);
    };

    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 100);
    };

    attempt();
  });
}

function postJson(url, body, headers = {}) {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
