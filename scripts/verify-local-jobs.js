#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DesktopAgentService } = require('../dist/agent/service');
const { getDefaultAgentSettings, saveAgentSettings } = require('../dist/agent/settings');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-local-jobs-'));
  const scopeDir = path.join(tmpDir, 'scope');
  fs.mkdirSync(scopeDir, { recursive: true });

  process.env.CI_DESKTOP_AGENT_SETTINGS_PATH = path.join(tmpDir, 'settings.json');
  process.env.CI_DESKTOP_AGENT_AUDIT_PATH = path.join(tmpDir, 'audit.jsonl');

  try {
    saveAgentSettings({
      ...getDefaultAgentSettings(),
      displayName: 'Local Job Verifier',
      enabled: false,
      deviceId: 'verify-device',
      ownerUserId: 'verify-owner',
      gatewayUrl: 'ws://127.0.0.1:1',
      fileAccessMode: 'selected_folders',
      allowedFolders: [scopeDir],
      approvalMode: 'session',
      controlMode: 'automation',
      allowShell: false,
      deviceApprovalGrants: [],
    });

    const service = new DesktopAgentService();

    const deniedBridge = await service.runLocalTool('files.write', {
      path: path.join(scopeDir, 'bridge-denied.txt'),
      content: 'blocked',
    });
    assert(!deniedBridge.ok, 'trusted bridge should still deny approval-required local tools');
    assert(!fs.existsSync(path.join(scopeDir, 'bridge-denied.txt')), 'trusted bridge denial should not write files');

    const writeJob = service.runLocalDesktopJob({
      tool: 'files.write',
      args: {
        path: path.join(scopeDir, 'approved.txt'),
        content: 'approved through local desktop job',
      },
      policy: { approvalMode: 'ask_every_time', timeoutMs: 15000 },
    });
    const writePrompt = await waitForJob(service, writeJob.jobId, (job) => job.pendingPrompt);
    assert(writePrompt.pendingPrompt.kind === 'approval', 'approval-required local job should request approval');
    service.respondToLocalDesktopPrompt(writePrompt.jobId, writePrompt.pendingPrompt.promptId, {
      approved: true,
      scope: 'once',
    });
    const writeDone = await waitForJob(service, writeJob.jobId, (job) => job.status === 'completed');
    assert(writeDone.status === 'completed', 'approved local write job should complete');
    assert(
      fs.readFileSync(path.join(scopeDir, 'approved.txt'), 'utf-8') === 'approved through local desktop job',
      'approved local write job should write inside selected scope',
    );

    const deniedJob = service.runLocalDesktopJob({
      tool: 'files.write',
      args: {
        path: path.join(scopeDir, 'denied.txt'),
        content: 'denied',
      },
      policy: { approvalMode: 'ask_every_time', timeoutMs: 15000 },
    });
    const deniedPrompt = await waitForJob(service, deniedJob.jobId, (job) => job.pendingPrompt);
    service.respondToLocalDesktopPrompt(deniedPrompt.jobId, deniedPrompt.pendingPrompt.promptId, {
      approved: false,
      scope: 'once',
    });
    const deniedDone = await waitForJob(service, deniedJob.jobId, (job) => job.status === 'failed');
    assert(deniedDone.error.includes('User denied approval'), 'denied local job should fail with approval error');
    assert(!fs.existsSync(path.join(scopeDir, 'denied.txt')), 'denied local job should not write files');

    const sessionJob = service.runLocalDesktopJob({
      tool: 'files.write',
      args: {
        path: path.join(scopeDir, 'session-one.txt'),
        content: 'session one',
      },
      policy: { approvalMode: 'session', timeoutMs: 15000 },
    });
    const sessionPrompt = await waitForJob(service, sessionJob.jobId, (job) => job.pendingPrompt);
    service.respondToLocalDesktopPrompt(sessionPrompt.jobId, sessionPrompt.pendingPrompt.promptId, {
      approved: true,
      scope: 'session',
    });
    await waitForJob(service, sessionJob.jobId, (job) => job.status === 'completed');

    const reusedSessionJob = service.runLocalDesktopJob({
      tool: 'files.write',
      args: {
        path: path.join(scopeDir, 'session-two.txt'),
        content: 'session two',
      },
      policy: { approvalMode: 'session', timeoutMs: 15000 },
    });
    const reusedSessionDone = await waitForJob(
      service,
      reusedSessionJob.jobId,
      (job) => job.status === 'completed' || job.pendingPrompt,
    );
    assert(!reusedSessionDone.pendingPrompt, 'session approval should be reused for the same tool');
    assert(fs.existsSync(path.join(scopeDir, 'session-two.txt')), 'session-approved local job should write file');

    const promptJob = service.runLocalDesktopJob({
      tool: 'agent.request_approval',
      args: { message: 'Cancel local prompt job?' },
      policy: { timeoutMs: 15000 },
    });
    await waitForJob(service, promptJob.jobId, (job) => job.pendingPrompt);
    service.cancelLocalDesktopJob(promptJob.jobId);
    const cancelled = await waitForJob(service, promptJob.jobId, (job) => job.status === 'cancelled');
    assert(cancelled.status === 'cancelled', 'local prompt job should be cancellable');

    const audit = service.readAuditEntries(100);
    assert(
      audit.some((entry) => entry.action === 'approval.decision' && entry.tool === 'files.write' && entry.result === 'allowed'),
      'approved local job should audit approval decision',
    );
    assert(
      audit.some((entry) => entry.action === 'approval.decision' && entry.tool === 'files.write' && entry.result === 'denied'),
      'denied local job should audit approval decision',
    );
    assert(
      audit.some((entry) => entry.action === 'job.cancel' && entry.jobId === promptJob.jobId),
      'cancelled local job should be audited',
    );

    console.log('Local desktop job verification passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function waitForJob(service, jobId, predicate) {
  const deadline = Date.now() + 15000;
  let lastJob;

  while (Date.now() < deadline) {
    const job = service.getLocalDesktopJob(jobId);
    if (job) {
      lastJob = job;
      if (predicate(job)) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for local job ${jobId}; last state ${JSON.stringify(lastJob)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
