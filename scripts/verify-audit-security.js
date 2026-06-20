#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-audit-security-'));
const auditPath = path.join(tmpDir, 'desktop-agent-audit.jsonl');
process.env.CI_DESKTOP_AGENT_AUDIT_PATH = auditPath;
process.env.CI_DESKTOP_AGENT_AUDIT_MAX_ENTRIES = '3';

const {
  appendAuditEntry,
  clearAuditEntries,
  getAuditInfo,
  readAuditEntries,
} = require('../dist/agent/audit');
const { runCapability } = require('../dist/agent/capabilities');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
try {
  appendAuditEntry({
    deviceId: 'verify-device',
    jobId: 'job_1',
    tool: 'secrets.save',
    action: 'tool.start',
    target: 'token=raw-token-value',
    result: 'allowed',
    error: 'Authorization: Bearer raw-bearer-value',
  });
  appendAuditEntry({
    deviceId: 'verify-device',
    jobId: 'job_2',
    tool: 'files.read',
    action: 'tool.finish',
    target: '/tmp/example.txt',
    result: 'completed',
  });
  appendAuditEntry({
    deviceId: 'verify-device',
    jobId: 'job_3',
    tool: 'files.write',
    action: 'tool.finish',
    target: 'password: raw-password-value',
    result: 'completed',
  });
  appendAuditEntry({
    deviceId: 'verify-device',
    jobId: 'job_4',
    tool: 'files.delete',
    action: 'tool.finish',
    target: '/tmp/delete.txt',
    result: 'completed',
  });

  const rawAudit = fs.readFileSync(auditPath, 'utf-8');
  assert(!rawAudit.includes('raw-token-value'), 'audit file should redact token values');
  assert(!rawAudit.includes('raw-bearer-value'), 'audit file should redact bearer values');
  assert(!rawAudit.includes('raw-password-value'), 'audit file should redact password values');

  const entries = readAuditEntries(10);
  assert(entries.length === 3, 'audit retention should keep max entries');
  assert(entries[0].jobId === 'job_2', 'audit retention should trim oldest entry');
  assert(!JSON.stringify(entries).includes('raw-password-value'), 'readAuditEntries should return redacted data');
  assert(readAuditEntries(1.8).length === 1, 'readAuditEntries should floor fractional limits');
  assert(readAuditEntries('not-a-number').length === 3, 'readAuditEntries should normalize non-numeric limits');

  const info = getAuditInfo();
  assert(info.path === auditPath, 'audit info should include audit path');
  assert(info.entries === 3, 'audit info should count retained entries');
  assert(info.maxEntries === 3, 'audit info should include max entries');
  assert(info.bytes > 0, 'audit info should include file size');

  clearAuditEntries();
  const clearedInfo = getAuditInfo();
  assert(clearedInfo.entries === 0, 'clearAuditEntries should remove entries');
  assert(readAuditEntries().length === 0, 'readAuditEntries should be empty after clear');

  process.env.CI_DESKTOP_AGENT_AUDIT_MAX_ENTRIES = '600';
  for (let index = 1; index <= 620; index += 1) {
    appendAuditEntry({
      deviceId: 'verify-device',
      jobId: `bulk_${index}`,
      tool: 'system.info',
      action: 'tool.finish',
      result: 'completed',
    });
  }
  assert(readAuditEntries(999999).length === 500, 'readAuditEntries should cap oversized read limits');
  assert(readAuditEntries(-1).length === 100, 'readAuditEntries should use the default limit for non-positive reads');

  clearAuditEntries();
  process.env.CI_DESKTOP_AGENT_AUDIT_MAX_ENTRIES = '20';
  const scopedRoot = path.join(tmpDir, 'scoped');
  fs.mkdirSync(scopedRoot, { recursive: true });
  const settings = {
    displayName: 'Audit Verifier',
    launchAtLogin: false,
    enabled: false,
    deviceId: 'audit-device',
    ownerUserId: 'audit-owner',
    gatewayUrl: 'ws://127.0.0.1:1',
    fileAccessMode: 'selected_folders',
    allowedFolders: [scopedRoot],
    controlMode: 'disabled',
    approvalMode: 'ask_every_time',
    allowShell: false,
    deviceApprovalGrants: [],
  };

  await runCapability({
    jobId: 'job_metadata',
    ownerUserId: 'audit-owner',
    targetDeviceId: 'audit-device',
    chatId: 'audit-chat',
    tool: 'files.write',
    args: {
      path: path.join(scopedRoot, 'notes.txt'),
      content: 'secret file content must not enter audit',
    },
  }, settings);

  await runCapability({
    jobId: 'job_url_metadata',
    ownerUserId: 'audit-owner',
    targetDeviceId: 'audit-device',
    chatId: 'audit-chat',
    tool: 'browser.open_url',
    args: {
      url: 'https://example.com/private/path?token=raw-url-token',
    },
  }, settings);

  const metadataEntries = readAuditEntries(20);
  const fileEntry = metadataEntries.find((entry) => (
    entry.jobId === 'job_metadata' &&
    entry.action === 'tool.start'
  ));
  assert(fileEntry, 'capability audit should include a file tool start entry');
  assert(fileEntry.ownerUserId === 'audit-owner', 'audit entry should include ownerUserId');
  assert(fileEntry.targetDeviceId === 'audit-device', 'audit entry should include targetDeviceId');
  assert(fileEntry.chatId === 'audit-chat', 'audit entry should include chatId');
  assert(fileEntry.target === path.join(scopedRoot, 'notes.txt'), 'audit entry should include safe file path target');

  const urlEntry = metadataEntries.find((entry) => (
    entry.jobId === 'job_url_metadata' &&
    entry.action === 'tool.start'
  ));
  assert(urlEntry?.target === 'https://example.com', 'audit URL target should keep only origin');

  const metadataJson = JSON.stringify(metadataEntries);
  assert(!metadataJson.includes('secret file content must not enter audit'), 'audit metadata should not include file write content');
  assert(!metadataJson.includes('raw-url-token'), 'audit metadata should not include URL query tokens');

  console.log('Audit security verification passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
