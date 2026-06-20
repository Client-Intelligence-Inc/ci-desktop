#!/usr/bin/env node

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const desktopAgentContract = require('../docs/desktop-agent-contract.json');

const port = Number(process.env.CI_DESKTOP_AGENT_MOCK_PORT || 47391);
const statePath = process.env.CI_DESKTOP_AGENT_STATE_PATH || '';
const offlineTimeoutMs = Number(process.env.CI_DESKTOP_AGENT_OFFLINE_TIMEOUT_MS || 75000);
const allowedOwnerUserId = process.env.CI_DESKTOP_AGENT_ALLOWED_OWNER_USER_ID || '';
const requireTargetDevice = process.env.CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE === '1';
const requirePairingToken = process.env.CI_DESKTOP_AGENT_REQUIRE_PAIRING_TOKEN === '1';
const chatApiToken = process.env.CI_DESKTOP_AGENT_CHAT_API_TOKEN || '';
const agentClients = new Set();
const chatClients = new Set();
const pendingPrompts = new Map();
const devices = new Map();
const deviceTokens = new Map();
const jobs = new Map();
const events = [];
const MAX_EVENTS = Math.max(Number(process.env.CI_DESKTOP_AGENT_MAX_EVENTS || 500), 1);
const MAX_STORED_STRING_LENGTH = 4096;
const MAX_LIVE_TEXT_PREVIEW_CHARS = 100 * 1024;
const MAX_LIVE_BINARY_PREVIEW_BASE64_CHARS = 1024 * 1024;
const DEFAULT_JOB_POLICY = {
  approvalMode: 'session',
  timeoutMs: 120000,
};
const ALLOWED_APPROVAL_MODES = new Set(['ask_every_time', 'session', 'device', 'always_for_owner']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const CAPABILITY_INPUT_SCHEMAS = new Map(
  (desktopAgentContract.capabilities || []).map((capability) => [
    capability.name,
    capability.inputSchema || { type: 'object', properties: {} },
  ]),
);
const CAPABILITY_OUTPUT_SCHEMAS = new Map(
  (desktopAgentContract.capabilities || []).map((capability) => [
    capability.name,
    capability.outputSchema || { type: 'object', properties: {} },
  ]),
);
const KNOWN_DESKTOP_TOOLS = new Set(CAPABILITY_INPUT_SCHEMAS.keys());
let eventSeq = 0;

loadPersistedState();
const staleDeviceSweep = setInterval(
  sweepStaleDevices,
  Math.min(Math.max(Math.floor(offlineTimeoutMs / 2), 1000), 30000),
);
staleDeviceSweep.unref?.();
const jobExpirySweep = setInterval(expireJobs, 1000);
jobExpirySweep.unref?.();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderChatPage());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    if (!requireChatApiAuth(request, response, url)) return;
    const ownerUserId = getOwnerUserIdFromRequest(request, url);
    const chatId = getChatIdFromRequest(request, url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(getStateSnapshot(ownerUserId, chatId)));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/devices') {
    if (!requireChatApiAuth(request, response, url)) return;
    const ownerUserId = getOwnerUserIdFromRequest(request, url);
    const filteredDevices = [...devices.values()].filter((device) => (
      !ownerUserId || device.ownerUserId === ownerUserId
    ));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ devices: filteredDevices.map(redactDeviceRecord) }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    if (!requireChatApiAuth(request, response, url)) return;
    const ownerUserId = getOwnerUserIdFromRequest(request, url);
    const chatId = getChatIdFromRequest(request, url);
    const cursor = getReplayCursor(url);
    expireJobs();
    const replayEvents = events.filter((event) => (
      (event.seq || 0) > cursor.afterSeq &&
      eventMatchesScope(event, ownerUserId, chatId)
    ));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      events: replayEvents,
      ...getReplayMeta(cursor.afterSeq),
      lastSeq: eventSeq,
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/desktop/devices/pair') {
    try {
      const body = await readJson(request);
      if (requirePairingToken && !getBearerTokenFromRequest(request)) {
        throw new Error('Pairing bearer token is required');
      }
      const ownerUserId = String(body.ownerUserId || 'josh-local');
      assertAllowedOwner(ownerUserId);
      const displayName = String(body.displayName || 'Josh Mac Studio');
      const deviceId = String(body.existingDeviceId || `dev_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      const deviceToken = `mock_device_token_${Math.random().toString(16).slice(2)}${Date.now()}`;
      const now = new Date().toISOString();

      const deviceTokenHash = hashDeviceToken(deviceToken);
      deviceTokens.set(deviceTokenHash, deviceId);
      devices.set(deviceId, {
        id: deviceId,
        ownerUserId,
        displayName,
        deviceTokenHash,
        status: 'paired',
        capabilities: [],
        activeJobIds: [],
        activeJobs: [],
        createdAt: devices.get(deviceId)?.createdAt || now,
        lastSeenAt: now,
      });
      appendEvent({
        direction: 'system',
        ownerUserId,
        type: 'device.paired',
        payload: {
          deviceId,
          ownerUserId,
          displayName,
        },
      });
      sendToChats({
        direction: 'system',
        ownerUserId,
        message: `Paired device ${displayName}`,
        state: getStateSnapshot(),
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        deviceId,
        deviceToken,
        ownerUserId,
      }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  const revokeMatch = url.pathname.match(/^\/api\/desktop\/devices\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && revokeMatch) {
    try {
      const deviceId = decodeURIComponent(revokeMatch[1]);
      const device = devices.get(deviceId);
      if (!device) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'Device not found' }));
        return;
      }
      requireAuthorizedDeviceRequest(request, deviceId);

      for (const [token, tokenDeviceId] of deviceTokens.entries()) {
        if (tokenDeviceId === deviceId) {
          deviceTokens.delete(token);
        }
      }

      devices.set(deviceId, {
        ...device,
        status: 'revoked',
        revokedAt: new Date().toISOString(),
        connectionId: undefined,
        activeJobIds: [],
        activeJobs: [],
      });

      for (const client of agentClients) {
        if (client._mockDeviceId === deviceId) {
          client.close(4001, 'device revoked');
        }
      }

      appendEvent({
        direction: 'system',
        ownerUserId: device.ownerUserId,
        type: 'device.revoked',
        payload: { deviceId },
      });
      sendToChats({
        direction: 'system',
        ownerUserId: device.ownerUserId,
        message: `Revoked device ${device.displayName || deviceId}`,
        state: getStateSnapshot(),
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.writeHead(getErrorStatusCode(error, 400), { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    if (!requireChatApiAuth(request, response, url)) return;
    const ownerUserId = getOwnerUserIdFromRequest(request, url);
    const chatId = getChatIdFromRequest(request, url);
    expireJobs();
    const filteredJobs = [...jobs.values()].filter((job) => (
      (!ownerUserId || job.ownerUserId === ownerUserId) &&
      (!chatId || job.chatId === chatId)
    ));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jobs: filteredJobs.map(redactJobRecord) }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    if (!requireChatApiAuth(request, response, url)) return;
    try {
      const body = await readJson(request);
      const job = body.tool
        ? makeJob(body.tool, body.args || {}, body.policy)
        : parseCommand(String(body.command || ''));
      const ownerUserId = resolveOwnerUserId(body.ownerUserId);
      const chatId = resolveChatId(body.chatId);
      const targetDeviceId = resolveTargetDeviceId(body.deviceId, ownerUserId);
      const targetOwnerUserId = devices.get(targetDeviceId)?.ownerUserId || ownerUserId;
      broadcastJob(job, targetDeviceId, targetOwnerUserId, chatId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        job: redactJobRecord({
          ...job,
          deviceId: targetDeviceId,
          ownerUserId: targetOwnerUserId,
          chatId,
        }),
        deviceId: targetDeviceId,
        ownerUserId: targetOwnerUserId,
        chatId,
      }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    if (!requireChatApiAuth(request, response, url)) return;
    try {
      const body = await readJson(request);
      const jobId = cancelMatch[1];
      const cancelEvent = {
        type: 'job.cancel',
        jobId,
        reason: body.reason || 'cancelled_from_mock_chat',
      };
      const job = requireJob(jobId);
      const targetDeviceId = job.deviceId;
      assertJobOwner(jobId, body.ownerUserId);
      assertJobChat(jobId, body.chatId);
      const sent = sendToAgents(cancelEvent, targetDeviceId);
      clearPendingPromptsForJob(jobId);
      updateJob(jobId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        error: cancelEvent.reason,
      });
      appendEvent({
        direction: 'user',
        jobId,
        ownerUserId: job.ownerUserId,
        chatId: job.chatId,
        type: 'job.cancel',
        deviceId: targetDeviceId,
        payload: cancelEvent,
      });
      sendToChats({
        direction: 'user',
        ownerUserId: job.ownerUserId,
        chatId: job.chatId,
        message: `cancelled ${jobId}; sent to ${sent} connected agent(s)`,
        event: cancelEvent,
        state: getStateSnapshot(),
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, sent }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/respond') {
    if (!requireChatApiAuth(request, response, url)) return;
    try {
      const body = await readJson(request);
      const responseEvent = {
        type: 'job.user_response',
        jobId: String(body.jobId || ''),
        promptId: String(body.promptId || ''),
        response: body.response || {},
      };

      if (!responseEvent.jobId || !responseEvent.promptId) {
        throw new Error('jobId and promptId are required');
      }

      const job = requireJob(responseEvent.jobId);
      const targetDeviceId = job.deviceId;
      assertJobOwner(responseEvent.jobId, body.ownerUserId);
      assertJobChat(responseEvent.jobId, body.chatId);
      const pendingPrompt = pendingPrompts.get(responseEvent.promptId);
      if (!pendingPrompt || pendingPrompt.jobId !== responseEvent.jobId) {
        throw new Error('Prompt is not pending for this job');
      }
      pendingPrompts.delete(responseEvent.promptId);
      const sent = sendToAgents(responseEvent, targetDeviceId);
      appendEvent({
        direction: 'user',
        jobId: responseEvent.jobId,
        ownerUserId: job.ownerUserId,
        chatId: job.chatId,
        type: 'job.user_response',
        deviceId: targetDeviceId,
        payload: redactResponseEvent(responseEvent),
      });
      sendToChats({
        direction: 'user',
        ownerUserId: job.ownerUserId,
        chatId: job.chatId,
        message: `sent response for ${responseEvent.promptId} to ${sent} connected agent(s)`,
        event: redactResponseEvent(responseEvent),
        state: getStateSnapshot(),
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, sent }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: 'not found' }));
});

const agentWss = new WebSocketServer({ noServer: true });
const chatWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

  if (url.pathname === '/desktop-agent/connect') {
    if (process.env.CI_DESKTOP_AGENT_REQUIRE_TOKEN === '1' && !getDeviceIdFromRequest(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    agentWss.handleUpgrade(request, socket, head, (ws) => agentWss.emit('connection', ws, request));
    return;
  }

  if (url.pathname === '/chat') {
    if (!isChatApiAuthorized(request, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    chatWss.handleUpgrade(request, socket, head, (ws) => chatWss.emit('connection', ws, request));
    return;
  }

  socket.destroy();
});

agentWss.on('connection', (ws, request) => {
  agentClients.add(ws);
  ws._mockClientId = `conn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  ws._mockDeviceId = getDeviceIdFromRequest(request);
  console.log(`agent connected from ${request.socket.remoteAddress}`);
  sendToChats({ direction: 'system', message: 'Desktop agent connected', state: getStateSnapshot() });

  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
      console.log('<-', JSON.stringify(redactEvent(event), null, 2));
    } catch {
      event = { type: 'raw', message: raw.toString() };
      console.log('<-', raw.toString());
    }

    if (handleAgentEvent(ws, event)) {
      sendToChats({
        direction: 'agent',
        event: redactEvent(event, { includePreview: true }),
        state: getStateSnapshot(),
      });
    }
  });

  ws.on('close', () => {
    agentClients.delete(ws);
      for (const device of devices.values()) {
      if (device.connectionId === ws._mockClientId) {
        devices.set(device.id, {
          ...device,
          status: device.status === 'revoked' ? 'revoked' : 'offline',
          connectionId: undefined,
          activeJobIds: [],
          activeJobs: [],
          lastSeenAt: new Date().toISOString(),
        });
      }
    }
    persistState();
    console.log('agent disconnected');
    sendToChats({ direction: 'system', message: 'Desktop agent disconnected', state: getStateSnapshot() });
  });
});

chatWss.on('connection', (ws, request) => {
  const url = new URL(request.url || '/chat', `http://${request.headers.host || '127.0.0.1'}`);
  const ownerUserId = getOwnerUserIdFromRequest(request, url);
  const chatId = getChatIdFromRequest(request, url);
  const cursor = getReplayCursor(url);
  ws._mockOwnerUserId = ownerUserId;
  ws._mockChatId = chatId;
  chatClients.add(ws);

  ws.send(JSON.stringify({
    direction: 'system',
    message: `Connected to mock gateway. Agents online: ${agentClients.size}`,
    state: getStateSnapshot(ownerUserId, chatId),
    replay: getReplayMeta(cursor.afterSeq),
    lastSeq: eventSeq,
  }));

  const replayEvents = events.filter((event) => (
    (event.seq || 0) > cursor.afterSeq &&
    eventMatchesScope(event, ownerUserId, chatId)
  ));
  for (const event of replayEvents) {
    ws.send(JSON.stringify({
      direction: event.direction || 'replay',
      message: `Replayed ${event.type || 'event'} #${event.seq}`,
      event: event.payload,
      replay: true,
      seq: event.seq,
      id: event.id,
      state: getStateSnapshot(ownerUserId, chatId),
      replayCursor: getReplayMeta(cursor.afterSeq),
      lastSeq: eventSeq,
    }));
  }

  ws.on('close', () => chatClients.delete(ws));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock desktop agent gateway listening on ws://127.0.0.1:${port}/desktop-agent/connect`);
  console.log(`Mock chat UI available at http://127.0.0.1:${port}/`);
  console.log('Commands:');
  console.log('  open <url>');
  console.log('  open-browser <browser> :: <url>');
  console.log('  chrome <url>');
  console.log('  safari <url>');
  console.log('  screenshot');
  console.log('  screenshot-jpeg [quality] [width] [height]');
  console.log('  screenshot-source <sourceId> [width] [height]');
  console.log('  sources');
  console.log('  windows');
  console.log('  stream [seconds] [intervalMs]');
  console.log('  stream-jpeg [seconds] [intervalMs] [quality]');
  console.log('  stream-source <sourceId> [seconds] [intervalMs]');
  console.log('  app <name>');
  console.log('  activate-app <name>');
  console.log('  apps');
  console.log('  frontmost');
  console.log('  quit-app <name>');
  console.log('  sysinfo');
  console.log('  storage [path]');
  console.log('  network');
  console.log('  network-all');
  console.log('  clip-read');
  console.log('  clip-write <text>');
  console.log('  stat <path>');
  console.log('  list <path>');
  console.log('  read <path>');
  console.log('  tail <path> [:: lines]');
  console.log('  watch <path> [:: seconds] [:: intervalMs]');
  console.log('  download <path>');
  console.log('  upload <path> :: <base64>');
  console.log('  mkdir <path>');
  console.log('  copy <source> :: <destination>');
  console.log('  move <source> :: <destination>');
  console.log('  delete <path>');
  console.log('  delete-recursive <path>');
  console.log('  file-open <path>');
  console.log('  reveal <path>');
  console.log('  search <path> :: <query>');
  console.log('  click <x> <y> [button] [clickCount]');
  console.log('  click-in <expectedApp> :: <x> <y> [button] [clickCount]');
  console.log('  click-snap <x> <y> [button] [clickCount]');
  console.log('  click-snap-in <expectedApp> :: <x> <y> [button] [clickCount]');
  console.log('  drag <fromX> <fromY> <toX> <toY> [durationMs]');
  console.log('  drag-in <expectedApp> :: <fromX> <fromY> <toX> <toY> [durationMs]');
  console.log('  drag-snap <fromX> <fromY> <toX> <toY> [durationMs]');
  console.log('  drag-snap-in <expectedApp> :: <fromX> <fromY> <toX> <toY> [durationMs]');
  console.log('  scroll <deltaY> [deltaX] [x] [y]');
  console.log('  scroll-in <expectedApp> :: <deltaY> [deltaX] [x] [y]');
  console.log('  scroll-snap <deltaY> [deltaX] [x] [y]');
  console.log('  scroll-snap-in <expectedApp> :: <deltaY> [deltaX] [x] [y]');
  console.log('  type <text>');
  console.log('  type-in <expectedApp> :: <text>');
  console.log('  hotkey <key> [modifier...]');
  console.log('  hotkey-in <expectedApp> :: <key> [modifier...]');
  console.log('  press <key> [modifier...]');
  console.log('  press-in <expectedApp> :: <key> [modifier...]');
  console.log('  shell <command> [args...]');
  console.log('  applescript <script>');
  console.log('  secret-save <name> :: <secret>');
  console.log('  secret-exists <name>');
  console.log('  secret-delete <name>');
  console.log('  secret-fill <name>');
  console.log('  ask <message>');
  console.log('  secret <message>');
  console.log('  approval <message>');
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'gateway> ',
});

rl.prompt();

rl.on('line', (line) => {
  const command = line.trim();
  if (!command) {
    rl.prompt();
    return;
  }

  try {
    const ownerUserId = resolveOwnerUserId();
    const targetDeviceId = resolveTargetDeviceId(undefined, ownerUserId);
    broadcastJob(parseCommand(command), targetDeviceId, devices.get(targetDeviceId)?.ownerUserId || ownerUserId, 'mock-cli');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  rl.prompt();
});

function broadcastJob(
  job,
  targetDeviceId = resolveTargetDeviceId(),
  ownerUserId = devices.get(targetDeviceId)?.ownerUserId || resolveOwnerUserId(),
  chatId = job.chatId || resolveChatId(),
) {
  const jobForTarget = {
    ...job,
    targetDeviceId,
    ownerUserId,
    chatId,
  };
  const sent = sendToAgents(jobForTarget, targetDeviceId);
  const now = new Date().toISOString();
  const record = {
    id: job.jobId,
    deviceId: targetDeviceId,
    ownerUserId,
    chatId,
    status: sent > 0 ? 'running' : 'queued',
    tool: job.tool,
    args: job.args,
    policy: job.policy,
    payload: jobForTarget,
    createdAt: now,
    expiresAt: getQueuedJobExpiresAt({ createdAt: now, policy: job.policy }),
    startedAt: sent > 0 ? now : undefined,
    deliveryAttempts: sent > 0 ? 1 : 0,
    completedAt: undefined,
    error: undefined,
  };
  jobs.set(job.jobId, record);
  persistState();
  appendEvent({
    direction: 'user',
    jobId: job.jobId,
    deviceId: targetDeviceId,
    ownerUserId,
    chatId,
    type: 'job.start',
    payload: redactJobRecord(jobForTarget),
  });

  const message = `sent ${job.tool} to ${sent} connected agent(s) as ${job.jobId} for ${targetDeviceId || 'any device'}`;
  console.log(message);
  sendToChats({ direction: 'user', command: job.tool, job: redactJobRecord(record), ownerUserId, chatId, message, state: getStateSnapshot() });
}

function sendToAgents(event, targetDeviceId) {
  let sent = 0;

  for (const client of agentClients) {
    if (targetDeviceId && client._mockDeviceId !== targetDeviceId) continue;
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(signJobForDevice(event, client._mockDeviceId)));
      sent += 1;
    }
  }

  return sent;
}

function signJobForDevice(event, deviceId) {
  if (event?.type !== 'job.start') return event;
  const deviceTokenHash = devices.get(deviceId)?.deviceTokenHash;
  if (!deviceTokenHash) return event;

  const signedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    ...event,
    signature: {
      algorithm: 'hmac-sha256',
      signedAt,
      nonce,
      value: signJobPayload(event, deviceTokenHash, signedAt, nonce),
    },
  };
}

function signJobPayload(job, signingSecret, signedAt, nonce) {
  return crypto.createHmac('sha256', signingSecret)
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
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }

  return JSON.stringify(value);
}

function sendToChats(event) {
  for (const client of chatClients) {
    if (client.readyState !== client.OPEN) continue;
    if (!chatEventMatchesScope(event, client._mockOwnerUserId, client._mockChatId)) continue;
    client.send(JSON.stringify({
      ...event,
      state: client._mockOwnerUserId
        ? getStateSnapshot(client._mockOwnerUserId, client._mockChatId)
        : event.state || getStateSnapshot(),
      lastSeq: eventSeq,
    }));
  }
}

function chatEventMatchesScope(event, ownerUserId, chatId) {
  if (chatId && !chatEventMatchesChat(event, chatId)) return false;
  return chatEventMatchesOwner(event, ownerUserId);
}

function chatEventMatchesOwner(event, ownerUserId) {
  if (!ownerUserId) return true;

  if (event.ownerUserId) return event.ownerUserId === ownerUserId;
  if (event.job?.ownerUserId) return event.job.ownerUserId === ownerUserId;
  if (event.event && eventOwnerMatches({ payload: event.event, jobId: event.event.jobId, deviceId: event.event.deviceId }, ownerUserId)) {
    return true;
  }
  if (event.state) return true;

  return false;
}

function chatEventMatchesChat(event, chatId) {
  if (!chatId) return true;
  if (event.chatId) return event.chatId === chatId;
  if (event.job?.chatId) return event.job.chatId === chatId;
  if (event.event && eventChatMatches({ payload: event.event, jobId: event.event.jobId }, chatId)) {
    return true;
  }
  if (event.state) return true;
  return false;
}

function handleAgentEvent(ws, event) {
  const now = new Date().toISOString();

  if (!isAuthorizedAgentJobEvent(ws, event)) {
    return false;
  }

  if (event.type === 'hello') {
    const deviceId = event.deviceId || ws._mockDeviceId || 'mock-device';
    ws._mockDeviceId = deviceId;
    devices.set(deviceId, {
      ...devices.get(deviceId),
      id: deviceId,
      displayName: event.displayName,
      agentVersion: event.agentVersion,
      capabilities: event.capabilities || [],
      capabilityManifest: event.capabilityManifest || [],
      status: 'online',
      connectionId: ws._mockClientId,
      createdAt: devices.get(deviceId)?.createdAt || now,
      lastSeenAt: now,
      activeJobIds: [],
      activeJobs: [],
    });
    deliverQueuedJobs(ws, deviceId);
  }

  if (event.type === 'heartbeat') {
    const deviceId = event.deviceId || ws._mockDeviceId || 'mock-device';
    const existing = devices.get(deviceId) || {
      id: deviceId,
      displayName: 'Unknown desktop agent',
      capabilities: [],
      createdAt: now,
    };
    devices.set(deviceId, {
      ...existing,
      status: 'online',
      connectionId: ws._mockClientId,
      lastSeenAt: now,
      activeJobIds: normalizeActiveJobIds(event.activeJobIds),
      activeJobs: normalizeActiveJobs(event.activeJobs, event.activeJobIds, deviceId, now),
    });
  }

  if (event.type === 'job.progress') {
    updateJob(event.jobId, {
      status: 'running',
      lastMessage: event.message,
    });
  }

  if (event.type === 'job.input_required') {
    updateJob(event.jobId, {
      status: 'waiting_for_user',
      waitingPromptId: event.promptId,
      lastMessage: event.message,
    });
    pendingPrompts.set(event.promptId, {
      ...event,
      ownerUserId: jobs.get(event.jobId)?.ownerUserId,
      chatId: jobs.get(event.jobId)?.chatId,
      deviceId: jobs.get(event.jobId)?.deviceId,
    });
  }

  if (event.type === 'job.screenshot') {
    updateJob(event.jobId, {
      status: 'running',
      lastScreenshotAt: now,
    });
  }

  if (event.type === 'job.file_event') {
    updateJob(event.jobId, {
      status: 'running',
      lastFileEventAt: now,
      lastMessage: `${event.event?.action || 'changed'} ${event.event?.path || ''}`.trim(),
    });
  }

  if (event.type === 'job.result') {
    clearPendingPromptsForJob(event.jobId);
    updateJob(event.jobId, {
      status: event.status,
      completedAt: now,
      result: sanitizeStoredPayload(event.result),
      error: sanitizeStoredText(event.error),
      waitingPromptId: undefined,
    });
  }

  appendEvent({
    direction: 'agent',
    jobId: event.jobId,
    ownerUserId: jobs.get(event.jobId)?.ownerUserId || devices.get(ws._mockDeviceId)?.ownerUserId,
    chatId: jobs.get(event.jobId)?.chatId,
    deviceId: event.deviceId || jobs.get(event.jobId)?.deviceId || ws._mockDeviceId,
    type: event.type,
    payload: redactEvent(event),
  });
  return true;
}

function isAuthorizedAgentJobEvent(ws, event) {
  if (!isAgentJobEvent(event)) return true;

  const job = jobs.get(event.jobId);
  if (!job) {
    appendEvent({
      direction: 'system',
      ownerUserId: devices.get(ws._mockDeviceId)?.ownerUserId,
      deviceId: ws._mockDeviceId,
      type: 'agent.event.rejected',
      payload: {
        reason: 'unknown_job',
        jobId: event.jobId,
        eventType: event.type,
      },
    });
    return false;
  }

  if (job.deviceId && ws._mockDeviceId !== job.deviceId) {
    appendEvent({
      direction: 'system',
      jobId: event.jobId,
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      deviceId: ws._mockDeviceId,
      type: 'agent.event.rejected',
      payload: {
        reason: 'wrong_device',
        jobId: event.jobId,
        expectedDeviceId: job.deviceId,
        actualDeviceId: ws._mockDeviceId,
        eventType: event.type,
      },
    });
    return false;
  }

  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    appendEvent({
      direction: 'system',
      jobId: event.jobId,
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      deviceId: ws._mockDeviceId,
      type: 'agent.event.rejected',
      payload: {
        reason: 'terminal_job',
        jobId: event.jobId,
        status: job.status,
        eventType: event.type,
      },
    });
    return false;
  }

  if (event.type === 'job.result' && event.status === 'completed') {
    const validation = validateDesktopJobResult(job.tool, event.result || {});
    if (!validation.ok) {
      appendEvent({
        direction: 'system',
        jobId: event.jobId,
        ownerUserId: job.ownerUserId,
        chatId: job.chatId,
        deviceId: ws._mockDeviceId,
        type: 'agent.event.rejected',
        payload: {
          reason: 'invalid_result',
          jobId: event.jobId,
          eventType: event.type,
          tool: job.tool,
          error: validation.error || 'Invalid desktop job result',
        },
      });
      return false;
    }
  }

  return true;
}

function isAgentJobEvent(event) {
  return Boolean(
    event &&
    typeof event.jobId === 'string' &&
    [
      'job.progress',
      'job.input_required',
      'job.screenshot',
      'job.file_event',
      'job.result',
    ].includes(event.type),
  );
}

function updateJob(jobId, patch) {
  if (!jobId) return;
  const existing = jobs.get(jobId) || {
    id: jobId,
    status: 'unknown',
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, {
    ...existing,
    ...patch,
  });
  persistState();
}

function clearPendingPromptsForJob(jobId) {
  if (!jobId) return 0;

  let cleared = 0;
  for (const [promptId, prompt] of pendingPrompts) {
    if (prompt.jobId === jobId) {
      pendingPrompts.delete(promptId);
      cleared += 1;
    }
  }

  return cleared;
}

function deliverQueuedJobs(ws, deviceId) {
  expireJobs();
  let delivered = 0;
  let deliveredOwnerUserId;

  for (const job of jobs.values()) {
    if (job.status !== 'queued') continue;
    if (job.deviceId && job.deviceId !== deviceId) continue;

    const payload = job.payload || {
      type: 'job.start',
      jobId: job.id,
      tool: job.tool,
      args: job.args,
      policy: job.policy,
      ownerUserId: job.ownerUserId,
      targetDeviceId: job.deviceId,
      chatId: job.chatId,
    };

    if (ws.readyState !== ws.OPEN) continue;

    ws.send(JSON.stringify(signJobForDevice(payload, deviceId)));
    delivered += 1;
    deliveredOwnerUserId = job.ownerUserId || deliveredOwnerUserId;
    const deliveredAt = new Date().toISOString();
    updateJob(job.id, {
      status: 'running',
      deviceId,
      startedAt: deliveredAt,
      deliveredAt,
      expiresAt: getRunningJobExpiresAt({ ...job, startedAt: deliveredAt }),
      deliveryAttempts: (job.deliveryAttempts || 0) + 1,
    });
    appendEvent({
      direction: 'system',
      jobId: job.id,
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      type: 'job.delivered',
      payload: {
        jobId: job.id,
        deviceId,
      },
    });
  }

  if (delivered > 0) {
    sendToChats({
      direction: 'system',
      ownerUserId: deliveredOwnerUserId || devices.get(deviceId)?.ownerUserId,
      message: `Delivered ${delivered} queued job(s) to ${deviceId}`,
      state: getStateSnapshot(),
    });
  }
}

function expireJobs(nowMs = Date.now()) {
  expireQueuedJobs(nowMs);
  expireRunningJobs(nowMs);
}

function expireQueuedJobs(nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();

  for (const job of jobs.values()) {
    if (job.status !== 'queued') continue;
    const expiresAtMs = Date.parse(job.expiresAt || getQueuedJobExpiresAt(job) || '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;

    updateJob(job.id, {
      status: 'expired',
      completedAt: now,
      expiresAt: new Date(expiresAtMs).toISOString(),
      error: `Queued job expired after ${job.policy?.timeoutMs || DEFAULT_JOB_POLICY.timeoutMs}ms without delivery`,
    });
    clearPendingPromptsForJob(job.id);
    appendEvent({
      direction: 'system',
      jobId: job.id,
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      deviceId: job.deviceId,
      type: 'job.expired',
      payload: {
        jobId: job.id,
        deviceId: job.deviceId,
        status: 'expired',
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
  }
}

function expireRunningJobs(nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();

  for (const job of jobs.values()) {
    if (!['running', 'waiting_for_user'].includes(job.status)) continue;
    const expiresAtMs = Date.parse(getRunningJobExpiresAt(job) || '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;

    const reason = `Running job expired after ${job.policy?.timeoutMs || DEFAULT_JOB_POLICY.timeoutMs}ms without a terminal result`;
    const cancelEvent = {
      type: 'job.cancel',
      jobId: job.id,
      reason: 'backend_timeout',
    };
    const sent = sendToAgents(cancelEvent, job.deviceId);

    updateJob(job.id, {
      status: 'expired',
      completedAt: now,
      expiresAt: new Date(expiresAtMs).toISOString(),
      error: reason,
      waitingPromptId: undefined,
    });
    clearPendingPromptsForJob(job.id);
    appendEvent({
      direction: 'system',
      jobId: job.id,
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      deviceId: job.deviceId,
      type: 'job.expired',
      payload: {
        jobId: job.id,
        deviceId: job.deviceId,
        status: 'expired',
        reason: 'backend_timeout',
        sentCancelToAgents: sent,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
    sendToChats({
      direction: 'system',
      ownerUserId: job.ownerUserId,
      chatId: job.chatId,
      message: `Expired ${job.id} after backend timeout`,
      event: cancelEvent,
      state: getStateSnapshot(job.ownerUserId, job.chatId),
    });
  }
}

function getQueuedJobExpiresAt(job) {
  const createdAtMs = Date.parse(job.createdAt || '');
  const timeoutMs = Number(job.policy?.timeoutMs || DEFAULT_JOB_POLICY.timeoutMs);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return new Date(createdAtMs + timeoutMs).toISOString();
}

function getRunningJobExpiresAt(job) {
  const startedAtMs = Date.parse(job.startedAt || job.deliveredAt || job.createdAt || '');
  const timeoutMs = Number(job.policy?.timeoutMs || DEFAULT_JOB_POLICY.timeoutMs);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return new Date(startedAtMs + timeoutMs).toISOString();
}

function sweepStaleDevices() {
  const now = Date.now();

  for (const device of devices.values()) {
    if (device.status !== 'online') continue;

    const lastSeenAt = Date.parse(device.lastSeenAt || device.createdAt || '');
    if (!Number.isFinite(lastSeenAt) || now - lastSeenAt <= offlineTimeoutMs) continue;

    devices.set(device.id, {
      ...device,
      status: 'offline',
      connectionId: undefined,
      activeJobIds: [],
      activeJobs: [],
      offlineReason: 'heartbeat_timeout',
      lastOfflineAt: new Date().toISOString(),
    });

    for (const client of agentClients) {
      if (client._mockDeviceId === device.id) {
        client.close(4002, 'heartbeat timeout');
      }
    }

    appendEvent({
      direction: 'system',
      ownerUserId: device.ownerUserId,
      deviceId: device.id,
      type: 'device.offline',
      payload: {
        deviceId: device.id,
        reason: 'heartbeat_timeout',
      },
    });
    sendToChats({
      direction: 'system',
      ownerUserId: device.ownerUserId,
      message: `${device.displayName || device.id} marked offline after missed heartbeat`,
      state: getStateSnapshot(),
    });
  }
}

function appendEvent(event) {
  eventSeq += 1;
  events.push({
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    seq: eventSeq,
    createdAt: new Date().toISOString(),
    ...event,
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persistState();
}

function getReplayCursor(url) {
  const fallbackAfterSeq = getNumericReplayCursor(url);
  const lastEventId = url.searchParams.get('lastEventId');
  if (lastEventId) {
    const numericSeq = Number(lastEventId);
    if (Number.isFinite(numericSeq) && numericSeq >= 0) {
      return { afterSeq: numericSeq, lastEventId };
    }

    const matchingEvent = events.find((event) => event.id === lastEventId);
    return {
      afterSeq: matchingEvent?.seq || fallbackAfterSeq,
      lastEventId,
      cursorKnown: Boolean(matchingEvent),
    };
  }

  return {
    afterSeq: fallbackAfterSeq,
  };
}

function getNumericReplayCursor(url) {
  const after = Number(
    url.searchParams.get('after') ||
    url.searchParams.get('eventSeq') ||
    url.searchParams.get('lastSeq') ||
    0,
  );
  return Number.isFinite(after) && after >= 0 ? after : 0;
}

function getReplayMeta(afterSeq) {
  const firstSeq = events[0]?.seq || 0;
  const replayTruncated = Boolean(firstSeq && afterSeq < firstSeq - 1);

  return {
    replayFromSeq: afterSeq,
    firstSeq,
    retainedEventCount: events.length,
    maxRetainedEvents: MAX_EVENTS,
    replayTruncated,
  };
}

function loadPersistedState() {
  if (!statePath) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    eventSeq = Number(parsed.eventSeq || 0);

    for (const device of parsed.devices || []) {
      devices.set(device.id, {
        ...device,
        status: device.status === 'revoked' ? 'revoked' : 'offline',
        connectionId: undefined,
        activeJobIds: [],
        activeJobs: [],
      });
    }

    for (const [token, deviceId] of parsed.deviceTokens || []) {
      if (devices.get(deviceId)?.status !== 'revoked') {
        const normalizedToken = normalizeStoredToken(token);
        deviceTokens.set(normalizedToken, deviceId);
        const device = devices.get(deviceId);
        if (device && !device.deviceTokenHash) {
          devices.set(deviceId, {
            ...device,
            deviceTokenHash: normalizedToken,
          });
        }
      }
    }

    for (const job of parsed.jobs || []) {
      const terminal = ['completed', 'failed', 'cancelled', 'expired'].includes(job.status);
      jobs.set(job.id, {
        ...job,
        status: terminal ? job.status : 'queued',
        restoredAt: new Date().toISOString(),
      });
    }

    for (const event of parsed.events || []) {
      events.push(event);
      if (typeof event.seq === 'number') {
        eventSeq = Math.max(eventSeq, event.seq);
      }
    }
  } catch {
    // Missing or invalid state should not stop the mock gateway from starting.
  }
}

function persistState() {
  if (!statePath) return;

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    devices: [...devices.values()].map((device) => {
      const {
        deviceTokenHash: _deviceTokenHash,
        ...persistableDevice
      } = device;
      return {
        ...persistableDevice,
        connectionId: undefined,
        activeJobIds: [],
        activeJobs: [],
      };
    }),
    deviceTokens: [...deviceTokens.entries()],
    jobs: [...jobs.values()].map(redactJobRecord),
    events: events.slice(-MAX_EVENTS),
    eventSeq,
  };

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, statePath);
}

function getStateSnapshot(ownerUserId, chatId) {
  expireJobs();
  const scopedDevices = [...devices.values()].filter((device) => (
    !ownerUserId || device.ownerUserId === ownerUserId
  ));
  const scopedJobs = [...jobs.values()].filter((job) => (
    (!ownerUserId || job.ownerUserId === ownerUserId) &&
    (!chatId || job.chatId === chatId)
  ));
  const scopedEvents = events.filter((event) => eventMatchesScope(event, ownerUserId, chatId));
  const scopedPrompts = [...pendingPrompts.values()].filter((prompt) => (
    (!ownerUserId ||
      prompt.ownerUserId === ownerUserId ||
      jobs.get(prompt.jobId)?.ownerUserId === ownerUserId) &&
    (!chatId ||
      prompt.chatId === chatId ||
      jobs.get(prompt.jobId)?.chatId === chatId)
  ));

  return {
    devices: scopedDevices.map(redactDeviceRecord),
    jobs: scopedJobs.slice(-50).reverse().map(redactJobRecord),
    events: scopedEvents.slice(-100).reverse(),
    pendingPrompts: scopedPrompts.map(redactEvent),
    connectedAgents: ownerUserId
      ? scopedDevices.filter((device) => device.status === 'online').length
      : agentClients.size,
    connectedChats: chatClients.size,
  };
}

function redactDeviceRecord(device) {
  const {
    deviceTokenHash: _deviceTokenHash,
    connectionId,
    ...safeDevice
  } = device;
  return {
    ...safeDevice,
    activeJobIds: normalizeActiveJobIds(safeDevice.activeJobIds),
    activeJobs: normalizeActiveJobs(safeDevice.activeJobs, safeDevice.activeJobIds, safeDevice.id, new Date().toISOString()),
    connectionId: connectionId ? '[connected]' : undefined,
  };
}

function normalizeActiveJobIds(activeJobIds) {
  if (!Array.isArray(activeJobIds)) return [];
  return activeJobIds
    .map((jobId) => cleanMetadataString(jobId, 160))
    .filter(Boolean);
}

function normalizeActiveJobs(activeJobs, activeJobIds, deviceId, fallbackStartedAt) {
  const ids = normalizeActiveJobIds(activeJobIds);
  const summaries = Array.isArray(activeJobs) ? activeJobs : [];
  const summariesById = new Map();

  for (const summary of summaries) {
    if (!summary || typeof summary !== 'object') continue;
    const jobId = cleanMetadataString(summary.jobId, 160);
    if (!jobId) continue;
    summariesById.set(jobId, summary);
  }

  const idsToRender = ids.length > 0 ? ids : [...summariesById.keys()];

  return idsToRender.map((jobId) => {
    const summary = summariesById.get(jobId) || {};
    const job = jobs.get(jobId);
    return {
      jobId,
      tool: cleanMetadataString(summary.tool, 160) || cleanMetadataString(job?.tool, 160) || 'unknown',
      ownerUserId: cleanMetadataString(summary.ownerUserId, 160) || cleanMetadataString(job?.ownerUserId, 160),
      targetDeviceId: cleanMetadataString(summary.targetDeviceId, 160) ||
        cleanMetadataString(job?.deviceId, 160) ||
        cleanMetadataString(deviceId, 160),
      chatId: cleanMetadataString(summary.chatId, 160) || cleanMetadataString(job?.chatId, 160),
      startedAt: isIsoLikeString(summary.startedAt)
        ? summary.startedAt
        : (isIsoLikeString(job?.startedAt) ? job.startedAt : fallbackStartedAt),
    };
  });
}

function cleanMetadataString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function isIsoLikeString(value) {
  if (typeof value !== 'string' || !value) return false;
  return Number.isFinite(Date.parse(value));
}

function eventMatchesScope(event, ownerUserId, chatId) {
  return eventOwnerMatches(event, ownerUserId) && eventChatMatches(event, chatId);
}

function eventOwnerMatches(event, ownerUserId) {
  if (!ownerUserId) return true;
  if (event.ownerUserId) return event.ownerUserId === ownerUserId;
  if (event.jobId && jobs.get(event.jobId)?.ownerUserId === ownerUserId) return true;
  if (event.deviceId && devices.get(event.deviceId)?.ownerUserId === ownerUserId) return true;

  const payload = event.payload || {};
  if (payload.ownerUserId) return payload.ownerUserId === ownerUserId;
  if (payload.deviceId && devices.get(payload.deviceId)?.ownerUserId === ownerUserId) return true;
  if (payload.jobId && jobs.get(payload.jobId)?.ownerUserId === ownerUserId) return true;

  return false;
}

function eventChatMatches(event, chatId) {
  if (!chatId) return true;
  if (event.chatId) return event.chatId === chatId;
  if (event.jobId && jobs.get(event.jobId)?.chatId === chatId) return true;

  const payload = event.payload || {};
  if (payload.chatId) return payload.chatId === chatId;
  if (payload.jobId && jobs.get(payload.jobId)?.chatId === chatId) return true;

  return false;
}

function getDeviceIdFromRequest(request) {
  const token = getBearerTokenFromRequest(request);
  return token ? deviceTokens.get(hashDeviceToken(token)) : undefined;
}

function getBearerTokenFromRequest(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function requireChatApiAuth(request, response, url) {
  if (isChatApiAuthorized(request, url)) return true;

  response.writeHead(401, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ok: false,
    error: 'Mock chat API bearer token is required',
  }));
  return false;
}

function isChatApiAuthorized(request, url) {
  if (!chatApiToken) return true;
  const bearerToken = getBearerTokenFromRequest(request);
  const queryToken = url.searchParams.get('chatToken') || '';
  return bearerToken === chatApiToken || queryToken === chatApiToken;
}

function requireAuthorizedDeviceRequest(request, deviceId) {
  if (process.env.CI_DESKTOP_AGENT_REQUIRE_TOKEN !== '1') return;

  const authorizedDeviceId = getDeviceIdFromRequest(request);
  if (!authorizedDeviceId) {
    throw httpError(401, 'Device bearer token is required');
  }
  if (authorizedDeviceId !== deviceId) {
    throw httpError(403, 'Device bearer token is not authorized for this device');
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getErrorStatusCode(error, fallbackStatusCode) {
  return typeof error?.statusCode === 'number' ? error.statusCode : fallbackStatusCode;
}

function hashDeviceToken(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

function normalizeStoredToken(token) {
  const value = String(token || '');
  return value.startsWith('sha256:') ? value : hashDeviceToken(value);
}

function getOwnerUserIdFromRequest(request, url) {
  return url.searchParams.get('ownerUserId') ||
    request.headers['x-ci-owner-user-id'] ||
    undefined;
}

function getChatIdFromRequest(request, url) {
  return url.searchParams.get('chatId') ||
    request.headers['x-ci-chat-id'] ||
    undefined;
}

function resolveOwnerUserId(requestedOwnerUserId) {
  if (requestedOwnerUserId) {
    const ownerUserId = String(requestedOwnerUserId);
    assertAllowedOwner(ownerUserId);
    return ownerUserId;
  }

  const preferred = [...devices.values()].find((device) => device.status === 'online') ||
    [...devices.values()].find((device) => device.status !== 'revoked');

  const ownerUserId = preferred?.ownerUserId || allowedOwnerUserId || 'josh-local';
  assertAllowedOwner(ownerUserId);
  return ownerUserId;
}

function resolveChatId(requestedChatId) {
  return String(requestedChatId || 'mock-chat');
}

function assertAllowedOwner(ownerUserId) {
  if (!allowedOwnerUserId) return;
  if (String(ownerUserId) !== allowedOwnerUserId) {
    throw new Error(`Owner ${ownerUserId} is not allowed by this personal mock gateway`);
  }
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function resolveTargetDeviceId(requestedDeviceId, ownerUserId = resolveOwnerUserId()) {
  if (requestedDeviceId) {
    const device = devices.get(String(requestedDeviceId));
    if (!device) throw new Error(`Unknown device: ${requestedDeviceId}`);
    if (device.status === 'revoked') throw new Error(`Device is revoked: ${requestedDeviceId}`);
    if (ownerUserId && device.ownerUserId !== ownerUserId) {
      throw new Error(`Device ${requestedDeviceId} does not belong to owner ${ownerUserId}`);
    }
    return String(requestedDeviceId);
  }

  const availableDevices = [...devices.values()].filter((device) => (
    device.ownerUserId === ownerUserId &&
    device.status !== 'revoked'
  ));
  if (requireTargetDevice && availableDevices.length > 1) {
    throw new Error(`Multiple devices are available for owner ${ownerUserId}; specify deviceId`);
  }

  const preferred = availableDevices.find((device) => device.status === 'online') || availableDevices[0];

  return preferred?.id || 'mock-device';
}

function assertJobOwner(jobId, requestedOwnerUserId) {
  if (!requestedOwnerUserId) return;
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  if (job.ownerUserId !== String(requestedOwnerUserId)) {
    throw new Error(`Job ${jobId} does not belong to owner ${requestedOwnerUserId}`);
  }
}

function assertJobChat(jobId, requestedChatId) {
  if (!requestedChatId) return;
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  if (job.chatId !== String(requestedChatId)) {
    throw new Error(`Job ${jobId} does not belong to chat ${requestedChatId}`);
  }
}

function requireJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  return job;
}

function parseCommand(command) {
  const [verb, ...rest] = command.split(' ');
  const text = rest.join(' ');

  switch (verb) {
    case 'open':
      return makeJob('browser.open_url', { url: text });
    case 'open-browser': {
      const [browser, url] = text.split(' :: ');
      if (!browser || !url) throw new Error('Usage: open-browser <browser> :: <url>');
      return makeJob('browser.open_url', { browser, url });
    }
    case 'chrome':
      return makeJob('browser.open_url', { browser: 'chrome', url: text });
    case 'safari':
      return makeJob('browser.open_url', { browser: 'safari', url: text });
    case 'screenshot':
      return makeJob('screen.screenshot', {});
    case 'screenshot-jpeg': {
      const quality = Number(rest[0] || 75);
      const width = Number(rest[1]);
      const height = Number(rest[2]);
      return makeJob('screen.screenshot', {
        format: 'jpeg',
        quality: clampNumber(quality, 1, 100),
        ...(Number.isFinite(width) ? { width } : {}),
        ...(Number.isFinite(height) ? { height } : {}),
      });
    }
    case 'screenshot-source': {
      const [sourceId, rawWidth, rawHeight, format, rawQuality] = rest;
      if (!sourceId) throw new Error('Usage: screenshot-source <sourceId> [width] [height] [format] [quality]');
      const width = Number(rawWidth);
      const height = Number(rawHeight);
      const quality = Number(rawQuality);
      return makeJob('screen.screenshot', {
        sourceId,
        ...(Number.isFinite(width) ? { width } : {}),
        ...(Number.isFinite(height) ? { height } : {}),
        ...(format ? { format } : {}),
        ...(Number.isFinite(quality) ? { quality: clampNumber(quality, 1, 100) } : {}),
      });
    }
    case 'sources':
      return makeJob('screen.sources', {});
    case 'windows':
      return makeJob('screen.sources', { includeWindows: true });
    case 'stream': {
      const seconds = Number(rest[0] || 15);
      const intervalMs = Number(rest[1] || 3000);
      return makeJob('screen.stream', {
        durationMs: Math.min(Math.max(seconds, 1), 300) * 1000,
        intervalMs: Math.min(Math.max(intervalMs, 1000), 30000),
      });
    }
    case 'stream-jpeg': {
      const seconds = Number(rest[0] || 15);
      const intervalMs = Number(rest[1] || 3000);
      const quality = Number(rest[2] || 75);
      return makeJob('screen.stream', {
        format: 'jpeg',
        quality: clampNumber(quality, 1, 100),
        durationMs: Math.min(Math.max(seconds, 1), 300) * 1000,
        intervalMs: Math.min(Math.max(intervalMs, 1000), 30000),
      });
    }
    case 'stream-source': {
      const [sourceId, rawSeconds, rawIntervalMs, format, rawQuality] = rest;
      if (!sourceId) throw new Error('Usage: stream-source <sourceId> [seconds] [intervalMs] [format] [quality]');
      const seconds = Number(rawSeconds || 15);
      const intervalMs = Number(rawIntervalMs || 3000);
      const quality = Number(rawQuality);
      return makeJob('screen.stream', {
        sourceId,
        durationMs: Math.min(Math.max(seconds, 1), 300) * 1000,
        intervalMs: Math.min(Math.max(intervalMs, 1000), 30000),
        ...(format ? { format } : {}),
        ...(Number.isFinite(quality) ? { quality: clampNumber(quality, 1, 100) } : {}),
      });
    }
    case 'app':
      return makeJob('apps.open', { name: text });
    case 'activate-app':
      return makeJob('apps.activate', { name: text });
    case 'apps':
      return makeJob('apps.list', {});
    case 'frontmost':
      return makeJob('apps.frontmost', {});
    case 'quit-app':
      return makeJob('apps.quit', { name: text });
    case 'sysinfo':
      return makeJob('system.info', {});
    case 'storage':
      return makeJob('system.storage', text ? { path: text } : {});
    case 'network':
      return makeJob('system.network', {});
    case 'network-all':
      return makeJob('system.network', { includeInternal: true });
    case 'clip-read':
      return makeJob('clipboard.read_text', {});
    case 'clip-write':
      return makeJob('clipboard.write_text', { text });
    case 'stat':
      return makeJob('files.stat', { path: text });
    case 'list':
      return makeJob('files.list', { path: text });
    case 'read':
      return makeJob('files.read', { path: text });
    case 'tail': {
      const [tailPath, lineCount] = text.split(' :: ');
      if (!tailPath) throw new Error('Usage: tail <path> [:: lines]');
      return makeJob('files.tail', {
        path: tailPath,
        ...(lineCount ? { lines: Number(lineCount) } : {}),
      });
    }
    case 'watch': {
      const [watchPath, seconds, intervalMs] = text.split(' :: ');
      if (!watchPath) throw new Error('Usage: watch <path> [:: seconds] [:: intervalMs]');
      return makeJob('files.watch', {
        path: watchPath,
        ...(seconds ? { durationMs: Math.min(Math.max(Number(seconds), 1), 300) * 1000 } : {}),
        ...(intervalMs ? { intervalMs: Math.min(Math.max(Number(intervalMs), 1000), 30000) } : {}),
      });
    }
    case 'download':
      return makeJob('files.read_binary', { path: text });
    case 'upload': {
      const [uploadPath, contentBase64] = text.split(' :: ');
      if (!uploadPath || !contentBase64) throw new Error('Usage: upload <path> :: <base64>');
      return makeJob('files.write_binary', { path: uploadPath, contentBase64 });
    }
    case 'mkdir':
      return makeJob('files.mkdir', { path: text });
    case 'copy': {
      const [sourcePath, destinationPath] = text.split(' :: ');
      if (!sourcePath || !destinationPath) throw new Error('Usage: copy <source> :: <destination>');
      return makeJob('files.copy', { sourcePath, destinationPath });
    }
    case 'move': {
      const [sourcePath, destinationPath] = text.split(' :: ');
      if (!sourcePath || !destinationPath) throw new Error('Usage: move <source> :: <destination>');
      return makeJob('files.move', { sourcePath, destinationPath });
    }
    case 'delete':
      return makeJob('files.delete', { path: text });
    case 'delete-recursive':
      return makeJob('files.delete', { path: text, recursive: true });
    case 'file-open':
      return makeJob('files.open', { path: text });
    case 'reveal':
      return makeJob('files.reveal', { path: text });
    case 'search': {
      const [searchPath, query] = text.split(' :: ');
      if (!searchPath || !query) throw new Error('Usage: search <path> :: <query>');
      return makeJob('files.search', { path: searchPath, query, includeContent: false });
    }
    case 'click':
    case 'click-snap': {
      const [rawX, rawY, button, rawClickCount] = rest;
      const x = Number(rawX);
      const y = Number(rawY);
      const clickCount = rawClickCount === undefined ? undefined : Number(rawClickCount);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Usage: click <x> <y> [button] [clickCount]');
      }
      return makeJob('input.click', {
        x,
        y,
        ...(button ? { button } : {}),
        ...(Number.isFinite(clickCount) ? { clickCount } : {}),
      }, verb === 'click-snap' ? { screenshotAfterAction: true } : undefined);
    }
    case 'click-in':
    case 'click-snap-in': {
      const scoped = parseExpectedAppCommand(text, `${verb} <expectedApp> :: <x> <y> [button] [clickCount]`);
      const [rawX, rawY, button, rawClickCount] = scoped.commandText.split(/\s+/);
      const x = Number(rawX);
      const y = Number(rawY);
      const clickCount = rawClickCount === undefined ? undefined : Number(rawClickCount);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Usage: ${verb} <expectedApp> :: <x> <y> [button] [clickCount]`);
      }
      return makeJob('input.click', {
        x,
        y,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
        ...(button ? { button } : {}),
        ...(Number.isFinite(clickCount) ? { clickCount } : {}),
      }, verb === 'click-snap-in' ? { screenshotAfterAction: true } : undefined);
    }
    case 'drag':
    case 'drag-snap': {
      const [fromX, fromY, toX, toY, durationMs] = rest.map(Number);
      if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
        throw new Error(`Usage: ${verb} <fromX> <fromY> <toX> <toY> [durationMs]`);
      }
      return makeJob('input.drag', {
        fromX,
        fromY,
        toX,
        toY,
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
      }, verb === 'drag-snap' ? { screenshotAfterAction: true } : undefined);
    }
    case 'drag-in':
    case 'drag-snap-in': {
      const scoped = parseExpectedAppCommand(text, `${verb} <expectedApp> :: <fromX> <fromY> <toX> <toY> [durationMs]`);
      const [fromX, fromY, toX, toY, durationMs] = scoped.commandText.split(/\s+/).map(Number);
      if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
        throw new Error(`Usage: ${verb} <expectedApp> :: <fromX> <fromY> <toX> <toY> [durationMs]`);
      }
      return makeJob('input.drag', {
        fromX,
        fromY,
        toX,
        toY,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
      }, verb === 'drag-snap-in' ? { screenshotAfterAction: true } : undefined);
    }
    case 'scroll':
    case 'scroll-snap': {
      const [deltaY, deltaX, x, y] = rest.map(Number);
      if (!Number.isFinite(deltaY)) {
        throw new Error(`Usage: ${verb} <deltaY> [deltaX] [x] [y]`);
      }
      return makeJob('input.scroll', {
        deltaY,
        ...(Number.isFinite(deltaX) ? { deltaX } : {}),
        ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
      }, verb === 'scroll-snap' ? { screenshotAfterAction: true } : undefined);
    }
    case 'scroll-in':
    case 'scroll-snap-in': {
      const scoped = parseExpectedAppCommand(text, `${verb} <expectedApp> :: <deltaY> [deltaX] [x] [y]`);
      const [deltaY, deltaX, x, y] = scoped.commandText.split(/\s+/).map(Number);
      if (!Number.isFinite(deltaY)) {
        throw new Error(`Usage: ${verb} <expectedApp> :: <deltaY> [deltaX] [x] [y]`);
      }
      return makeJob('input.scroll', {
        deltaY,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
        ...(Number.isFinite(deltaX) ? { deltaX } : {}),
        ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
      }, verb === 'scroll-snap-in' ? { screenshotAfterAction: true } : undefined);
    }
    case 'type':
      return makeJob('input.type_text', { text });
    case 'type-in': {
      const scoped = parseExpectedAppCommand(text, 'type-in <expectedApp> :: <text>');
      return makeJob('input.type_text', {
        text: scoped.commandText,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
      });
    }
    case 'hotkey': {
      const [key, ...modifiers] = rest;
      return makeJob('input.hotkey', { key, modifiers });
    }
    case 'hotkey-in': {
      const scoped = parseExpectedAppCommand(text, 'hotkey-in <expectedApp> :: <key> [modifier...]');
      const [key, ...modifiers] = scoped.commandText.trim().split(/\s+/);
      return makeJob('input.hotkey', {
        key,
        modifiers,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
      });
    }
    case 'press': {
      const [key, ...modifiers] = rest;
      return makeJob('input.press_key', { key, modifiers });
    }
    case 'press-in': {
      const scoped = parseExpectedAppCommand(text, 'press-in <expectedApp> :: <key> [modifier...]');
      const [key, ...modifiers] = scoped.commandText.trim().split(/\s+/);
      return makeJob('input.press_key', {
        key,
        modifiers,
        expectedFrontmostApp: scoped.expectedFrontmostApp,
      });
    }
    case 'shell': {
      const [commandPath, ...args] = rest;
      return makeJob('shell.run', { command: commandPath, args });
    }
    case 'applescript':
      return makeJob('automation.applescript', { script: text });
    case 'secret-save': {
      const [name, secret] = text.split(' :: ');
      if (!name || !secret) throw new Error('Usage: secret-save <name> :: <secret>');
      return makeJob('secrets.save', { name, secret });
    }
    case 'secret-exists':
      return makeJob('secrets.exists', { name: text });
    case 'secret-delete':
      return makeJob('secrets.delete', { name: text });
    case 'secret-fill':
      return makeJob('secrets.fill_focused_field', { name: text });
    case 'ask':
      return makeJob('agent.ask_user', { message: text });
    case 'secret':
      return makeJob('agent.request_secret', { message: text });
    case 'approval':
      return makeJob('agent.request_approval', { message: text });
    default:
      throw new Error(`Unknown command: ${verb}`);
  }
}

function makeJob(tool, args, policy) {
  const normalizedTool = String(tool || '').trim();
  if (!KNOWN_DESKTOP_TOOLS.has(normalizedTool)) {
    throw new Error(`Unknown desktop tool: ${normalizedTool || '(empty)'}`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Desktop job args must be an object');
  }
  const validation = validateDesktopJobArgs(normalizedTool, args);
  if (!validation.ok) {
    throw new Error(validation.error || 'Desktop job args are invalid');
  }

  return {
    type: 'job.start',
    jobId: `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
    tool: normalizedTool,
    args,
    policy: validateJobPolicy(policy),
  };
}

function validateDesktopJobArgs(tool, args) {
  const schema = CAPABILITY_INPUT_SCHEMAS.get(tool);
  if (!schema) {
    return { ok: false, error: `Unknown desktop tool: ${tool}` };
  }
  return validateInputSchema(schema, args, 'args');
}

function validateDesktopJobResult(tool, result) {
  const schema = CAPABILITY_OUTPUT_SCHEMAS.get(tool);
  if (!schema) {
    return { ok: false, error: `Unknown desktop tool: ${tool}` };
  }
  return validateInputSchema(schema, result, 'result');
}

function validateInputSchema(schema, value, valuePath) {
  if (Array.isArray(schema?.anyOf)) {
    const errors = [];
    for (const option of schema.anyOf) {
      const result = validateInputSchema(option, value, valuePath);
      if (result.ok) return result;
      if (result.error) errors.push(result.error);
    }
    return { ok: false, error: `${valuePath} must match one allowed schema${errors.length ? ` (${errors.join('; ')})` : ''}` };
  }

  if (Object.prototype.hasOwnProperty.call(schema || {}, 'const') && value !== schema.const) {
    return { ok: false, error: `${valuePath} must equal ${JSON.stringify(schema.const)}` };
  }

  if (schema?.type) {
    const typeResult = validateSchemaType(String(schema.type), value, valuePath);
    if (!typeResult.ok) return typeResult;
  }

  if (schema?.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${valuePath} must be an object` };
    }

    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        return { ok: false, error: `${valuePath}.${key} is required` };
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (!isRecord(properties[key])) {
        return { ok: false, error: `${valuePath}.${key} is not allowed` };
      }
      const propertyResult = validateInputSchema(properties[key], value[key], `${valuePath}.${key}`);
      if (!propertyResult.ok) return propertyResult;
    }
  }

  if (schema?.type === 'array') {
    if (!Array.isArray(value)) {
      return { ok: false, error: `${valuePath} must be an array` };
    }
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemResult = validateInputSchema(schema.items, value[index], `${valuePath}[${index}]`);
        if (!itemResult.ok) return itemResult;
      }
    }
  }

  if (schema?.format === 'uri' && typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { ok: false, error: `${valuePath} must be an http or https URL` };
      }
    } catch {
      return { ok: false, error: `${valuePath} must be a valid URL` };
    }
  }

  return { ok: true };
}

function validateSchemaType(type, value, valuePath) {
  switch (type) {
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: `${valuePath} must be an object` };
    case 'array':
      return Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: `${valuePath} must be an array` };
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, error: `${valuePath} must be a string` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, error: `${valuePath} must be a finite number` };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, error: `${valuePath} must be a boolean` };
    default:
      return { ok: false, error: `${valuePath} uses unsupported schema type ${type}` };
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseExpectedAppCommand(text, usage) {
  const [expectedFrontmostApp, commandText] = text.split(' :: ');
  if (!expectedFrontmostApp || !commandText) {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    expectedFrontmostApp: expectedFrontmostApp.trim(),
    commandText: commandText.trim(),
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function validateJobPolicy(policy) {
  if (policy === undefined || policy === null) {
    return { ...DEFAULT_JOB_POLICY };
  }
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Desktop job policy must be an object');
  }

  const allowedKeys = new Set(['approvalMode', 'timeoutMs', 'screenshotAfterAction']);
  for (const key of Object.keys(policy)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Desktop job policy includes unsupported field: ${key}`);
    }
  }

  const normalizedPolicy = { ...DEFAULT_JOB_POLICY };
  if (policy.approvalMode !== undefined) {
    const approvalMode = String(policy.approvalMode);
    if (!ALLOWED_APPROVAL_MODES.has(approvalMode)) {
      throw new Error('Desktop job policy approvalMode must be valid');
    }
    normalizedPolicy.approvalMode = approvalMode;
  }
  if (policy.timeoutMs !== undefined) {
    if (typeof policy.timeoutMs !== 'number' || !Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
      throw new Error('Desktop job policy timeoutMs must be a positive number');
    }
    normalizedPolicy.timeoutMs = policy.timeoutMs;
  }
  if (policy.screenshotAfterAction !== undefined) {
    if (typeof policy.screenshotAfterAction !== 'boolean') {
      throw new Error('Desktop job policy screenshotAfterAction must be a boolean');
    }
    normalizedPolicy.screenshotAfterAction = policy.screenshotAfterAction;
  }
  return normalizedPolicy;
}

function redactEvent(event, options = {}) {
  const redacted = redactPayload(event);

  if (event.type === 'job.screenshot' && event.image?.data) {
    return {
      ...redacted,
      image: {
        ...redacted.image,
        data: `[base64 omitted: ${event.image.data.length} chars]`,
      },
      ...(options.includePreview
        ? { imagePreview: `data:${event.image.mimeType};base64,${event.image.data}` }
        : {}),
    };
  }

  if (options.includePreview) {
    const filePreview = buildLiveFilePreview(event);
    if (filePreview) {
      return {
        ...redacted,
        filePreview,
      };
    }
  }

  return redacted;
}

function redactJobRecord(job) {
  const redacted = redactPayload(job);
  if (job?.tool === 'clipboard.write_text') {
    redactClipboardWriteArgs(redacted, job);
  }
  return redacted;
}

function redactClipboardWriteArgs(redacted, original) {
  if (
    redacted?.args &&
    typeof redacted.args === 'object' &&
    'text' in redacted.args
  ) {
    redacted.args.text = describeRedactedValue(original.args?.text, 'content');
  }

  if (
    redacted?.payload?.args &&
    typeof redacted.payload.args === 'object' &&
    'text' in redacted.payload.args
  ) {
    redacted.payload.args.text = describeRedactedValue(original.payload?.args?.text, 'content');
  }
}

function redactPayload(value) {
  if (Array.isArray(value)) {
    return value.map(redactPayload);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      redacted[key] = describeRedactedValue(rawValue, key);
      continue;
    }

    redacted[key] = redactPayload(rawValue);
  }

  return redacted;
}

function buildLiveFilePreview(event) {
  if (event?.type !== 'job.result' || event.status !== 'completed') return undefined;
  const result = event.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;

  if (typeof result.content === 'string') {
    const truncated = result.content.length > MAX_LIVE_TEXT_PREVIEW_CHARS;
    return {
      kind: 'text',
      path: typeof result.path === 'string' ? result.path : undefined,
      size: typeof result.size === 'number' ? result.size : Buffer.byteLength(result.content),
      encoding: typeof result.encoding === 'string' ? result.encoding : 'utf-8',
      content: truncated ? result.content.slice(0, MAX_LIVE_TEXT_PREVIEW_CHARS) : result.content,
      truncated: Boolean(result.truncated) || truncated,
    };
  }

  if (typeof result.contentBase64 === 'string') {
    const truncated = result.contentBase64.length > MAX_LIVE_BINARY_PREVIEW_BASE64_CHARS;
    const fileName = typeof result.path === 'string' && result.path
      ? path.basename(result.path)
      : 'download.bin';
    return {
      kind: 'binary',
      path: typeof result.path === 'string' ? result.path : undefined,
      fileName,
      size: typeof result.size === 'number' ? result.size : Buffer.from(result.contentBase64, 'base64').length,
      encoding: 'base64',
      truncated,
      ...(truncated
        ? {}
        : {
            contentBase64: result.contentBase64,
            dataUrl: `data:application/octet-stream;base64,${result.contentBase64}`,
          }),
    };
  }

  return undefined;
}

function shouldRedactKey(key) {
  return (
    /password|secret|token|authorization/i.test(key) ||
    key === 'content' ||
    key === 'contentBase64' ||
    key === 'data' ||
    key === 'imagePreview'
  );
}

function describeRedactedValue(value, key) {
  if (typeof value === 'string') {
    if (key === 'contentBase64' || key === 'data') {
      return `[base64 omitted: ${value.length} chars]`;
    }
    if (key === 'content') {
      return `[content omitted: ${value.length} chars]`;
    }
  }

  return '[redacted]';
}

function sanitizeStoredPayload(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(sanitizeStoredPayload);
  }

  if (typeof value === 'string') {
    return sanitizeStoredText(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      sanitized[key] = describeRedactedValue(rawValue, key);
    } else {
      sanitized[key] = sanitizeStoredPayload(rawValue);
    }
  }

  return sanitized;
}

function sanitizeStoredText(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_STORED_STRING_LENGTH
    ? `${value.slice(0, MAX_STORED_STRING_LENGTH)}...[truncated ${value.length - MAX_STORED_STRING_LENGTH} chars]`
    : value;
}

function redactResponseEvent(event) {
  const response = event.response || {};
  return {
    ...event,
    response: {
      ...response,
      secret: response.secret ? '[redacted]' : undefined,
    },
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function renderChatPage() {
  const defaultOwner = allowedOwnerUserId || 'josh-local';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Client Intelligence Mock Desktop Chat</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #f9fafb; }
    main { max-width: 920px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    form { display: flex; gap: 8px; position: sticky; bottom: 0; background: #111827; padding: 12px 0; }
    input, select { flex: 1; border: 1px solid #374151; border-radius: 6px; background: #030712; color: #f9fafb; padding: 12px; font-size: 16px; }
    button { border: 0; border-radius: 6px; background: #2563eb; color: white; padding: 0 16px; font-weight: 600; }
    button.secondary { background: #374151; }
    button.danger { background: #b91c1c; }
    .setup { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
    .targeting { display: grid; gap: 8px; grid-template-columns: minmax(160px, 1fr) minmax(220px, 2fr); margin: 0 0 16px; }
    .targeting label { display: grid; gap: 4px; color: #d1d5db; font-size: 12px; }
    .targeting input, .targeting select { width: 100%; box-sizing: border-box; }
    .status { border: 1px solid #374151; border-radius: 8px; padding: 12px; margin: 0 0 16px; background: #030712; }
    .status-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .status-card { border: 1px solid #374151; border-radius: 6px; padding: 10px; background: #111827; }
    .status-card strong { display: block; margin-bottom: 4px; }
    .status-card small { color: #d1d5db; display: block; overflow-wrap: anywhere; }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; background: #374151; color: #f9fafb; }
    .badge.ready { background: #047857; }
    .badge.warn { background: #b45309; }
    .badge.blocked { background: #b91c1c; }
    details.status-details { margin-top: 8px; }
    details.status-details summary { color: #d1d5db; cursor: pointer; }
    .gateway { border: 1px solid #374151; border-radius: 8px; padding: 12px; margin: 0 0 16px; background: #111827; }
    .gateway h2 { margin: 0 0 8px; font-size: 15px; }
    .gateway-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .state-card { border: 1px solid #374151; border-radius: 6px; padding: 10px; background: #030712; }
    .state-card strong { display: block; margin-bottom: 4px; }
    .state-card small { color: #d1d5db; display: block; overflow-wrap: anywhere; }
    .prompt { display: grid; gap: 8px; margin-top: 10px; }
    .prompt-card { border: 1px solid #4b5563; border-radius: 6px; padding: 10px; margin-top: 10px; background: #030712; display: grid; gap: 8px; }
    .prompt-card.resolved { opacity: 0.65; }
    .prompt-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .prompt-card h3 { margin: 0; font-size: 15px; }
    .prompt-message { color: #f9fafb; }
    .prompt-meta { color: #9ca3af; font-size: 12px; overflow-wrap: anywhere; }
    .prompt-sensitive { color: #fbbf24; font-size: 12px; }
    .prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .prompt input { width: 100%; box-sizing: border-box; }
    .file-preview { border: 1px solid #374151; border-radius: 6px; padding: 10px; margin-top: 10px; background: #030712; }
    .file-preview strong { display: block; margin-bottom: 6px; }
    .file-preview pre { max-height: 320px; overflow: auto; background: #111827; padding: 10px; border-radius: 6px; }
    .file-preview a { color: #93c5fd; font-weight: 700; }
    .source-picker { border: 1px solid #374151; border-radius: 6px; padding: 10px; margin-top: 10px; background: #030712; display: grid; gap: 8px; }
    .source-row { border: 1px solid #374151; border-radius: 6px; padding: 8px; background: #111827; display: grid; gap: 6px; }
    .source-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .log { display: grid; gap: 10px; }
    .event { border: 1px solid #374151; border-radius: 8px; padding: 12px; background: #1f2937; overflow: auto; }
    .event.user { border-color: #2563eb; }
    .event.agent { border-color: #059669; }
    .event.system { color: #d1d5db; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; color: #e5e7eb; }
    img { max-width: 100%; border-radius: 6px; margin-top: 10px; border: 1px solid #374151; }
  </style>
</head>
<body>
  <main>
    <h1>Mock Client Intelligence Desktop Chat</h1>
    <div id="status" class="status">Desktop bridge status: checking...</div>
    <div class="setup">
      <button id="pair" type="button">Pair Local Device</button>
      <button id="connect" type="button" class="secondary">Connect Agent</button>
      <button id="launchAtLogin" type="button" class="secondary">Launch at Login</button>
      <button id="disableLaunchAtLogin" type="button" class="secondary">Disable Launch at Login</button>
      <button id="screen" type="button" class="secondary">Enable Screenshots</button>
      <button id="fullDisk" type="button" class="secondary">Use Full Disk Mode</button>
      <button id="chooseFolder" type="button" class="secondary">Choose Folder</button>
      <button id="clearFolders" type="button" class="secondary">Clear Folders</button>
      <button id="openFullDisk" type="button" class="secondary">Full Disk Settings</button>
      <button id="openAccessibility" type="button" class="secondary">Accessibility Settings</button>
      <button id="openScreenRecording" type="button" class="secondary">Screen Recording Settings</button>
      <button id="openAutomation" type="button" class="secondary">Automation Settings</button>
      <button id="refresh" type="button" class="secondary">Refresh Status</button>
      <button id="setupChecklist" type="button" class="secondary">Setup Checklist</button>
      <button id="showAudit" type="button" class="secondary">Show Audit</button>
      <button id="clearAudit" type="button" class="danger">Clear Audit</button>
    </div>
    <div class="targeting">
      <label>Owner
        <input id="targetOwner" value="${escapeHtmlAttribute(defaultOwner)}" autocomplete="off">
      </label>
      <label>Chat
        <input id="targetChat" value="mock-chat" autocomplete="off">
      </label>
      <label>Target Device
        <select id="targetDevice">
          <option value="">Auto-select owner device</option>
        </select>
      </label>
      <label>Mock API Token
        <input id="chatApiToken" type="password" autocomplete="off" placeholder="Only needed when gateway requires one">
      </label>
    </div>
    <section class="gateway">
      <h2>Mock Gateway State</h2>
      <div id="gatewayState" class="gateway-grid"></div>
    </section>
    <div id="log" class="log"></div>
    <form id="form">
      <input id="command" autocomplete="off" placeholder="Try: open https://clientintelligence.ai, screenshot, stream 15 3000, secret-save login :: code">
      <button>Send</button>
    </form>
  </main>
  <script>
    const log = document.getElementById('log');
    const form = document.getElementById('form');
    const command = document.getElementById('command');
    const status = document.getElementById('status');
    const gatewayState = document.getElementById('gatewayState');
    const targetOwner = document.getElementById('targetOwner');
    const targetChat = document.getElementById('targetChat');
    const targetDevice = document.getElementById('targetDevice');
    const chatApiToken = document.getElementById('chatApiToken');
    let ws;
    let reconnectTimer;
    let lastSeenSeq = Number(localStorage.getItem(seqStorageKey()) || 0);
    let lastSeenEventId = localStorage.getItem(eventIdStorageKey()) || '';
    let lastSeenEventSeq = Number(localStorage.getItem(eventIdSeqStorageKey()) || 0);
    const promptCards = new Map();

    connectChat();
    targetOwner.addEventListener('change', () => {
      resetChatStream();
    });
    targetChat.addEventListener('change', () => {
      resetChatStream();
    });
    chatApiToken.value = localStorage.getItem(chatApiTokenStorageKey()) || '';
    chatApiToken.addEventListener('change', () => {
      localStorage.setItem(chatApiTokenStorageKey(), chatApiToken.value);
      resetChatStream();
    });

    function resetChatStream() {
      lastSeenSeq = Number(localStorage.getItem(seqStorageKey()) || 0);
      lastSeenEventId = localStorage.getItem(eventIdStorageKey()) || '';
      lastSeenEventSeq = Number(localStorage.getItem(eventIdSeqStorageKey()) || 0);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      connectChat();
      refreshGatewayState();
    }

    function connectChat() {
      clearTimeout(reconnectTimer);
      const params = new URLSearchParams({
        ownerUserId: currentOwner(),
        chatId: currentChatId(),
        after: String(lastSeenSeq),
      });
      if (lastSeenEventId && lastSeenEventSeq === lastSeenSeq) {
        params.set('lastEventId', lastSeenEventId);
      }
      if (currentChatApiToken()) params.set('chatToken', currentChatApiToken());
      ws = new WebSocket(\`ws://\${location.host}/chat?\${params.toString()}\`);

      ws.onmessage = (message) => {
        const event = JSON.parse(message.data);
        if (event.id && typeof event.seq === 'number') rememberEventId(event.id, event.seq);
        if (typeof event.seq === 'number') rememberSeq(event.seq);
        if (typeof event.lastSeq === 'number') rememberSeq(event.lastSeq);
      if (event.state) renderGatewayState(event.state);
      append(event.direction || 'agent', event);
    };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connectChat, 1000);
      };
    }

    function rememberSeq(seq) {
      if (!Number.isFinite(seq)) return;
      lastSeenSeq = Math.max(lastSeenSeq, seq);
      localStorage.setItem(seqStorageKey(), String(lastSeenSeq));
    }

    function rememberEventId(eventId, seq) {
      if (!eventId || !Number.isFinite(seq)) return;
      lastSeenEventId = eventId;
      lastSeenEventSeq = seq;
      localStorage.setItem(eventIdStorageKey(), eventId);
      localStorage.setItem(eventIdSeqStorageKey(), String(seq));
    }

    function seqStorageKey() {
      return 'ci-desktop-mock-last-seq:' + currentOwner() + ':' + currentChatId();
    }

    function eventIdStorageKey() {
      return 'ci-desktop-mock-last-event-id:' + currentOwner() + ':' + currentChatId();
    }

    function eventIdSeqStorageKey() {
      return 'ci-desktop-mock-last-event-seq:' + currentOwner() + ':' + currentChatId();
    }

    function chatApiTokenStorageKey() {
      return 'ci-desktop-mock-chat-api-token';
    }

    function currentChatApiToken() {
      return chatApiToken.value.trim();
    }

    function authedHeaders(includeContentType = true) {
      const headers = includeContentType ? { 'content-type': 'application/json' } : {};
      if (currentChatApiToken()) headers.authorization = 'Bearer ' + currentChatApiToken();
      return headers;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = command.value.trim();
      if (!value) return;
      command.value = '';
      await fetch('/api/jobs', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ command: value, ...targetRequest() })
      });
    });

    document.getElementById('pair').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.pairPersonalDevice(currentOwner());
      await refreshStatus();
      await refreshGatewayState();
    });

    document.getElementById('connect').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.connect();
      await refreshStatus();
    });

    document.getElementById('launchAtLogin').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.updateSettings({ launchAtLogin: true });
      await refreshStatus();
    });

    document.getElementById('disableLaunchAtLogin').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.updateSettings({ launchAtLogin: false });
      await refreshStatus();
    });

    document.getElementById('screen').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.updateSettings({ controlMode: 'screen' });
      await refreshStatus();
    });

    document.getElementById('fullDisk').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.updateSettings({ fileAccessMode: 'full_disk' });
      await refreshStatus();
    });

    document.getElementById('chooseFolder').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.chooseAllowedFolder();
      await refreshStatus();
    });

    document.getElementById('clearFolders').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.clearAllowedFolders();
      await refreshStatus();
    });

    document.getElementById('openFullDisk').addEventListener('click', () => openPermission('full_disk_access'));
    document.getElementById('openAccessibility').addEventListener('click', () => openPermission('accessibility'));
    document.getElementById('openScreenRecording').addEventListener('click', () => openPermission('screen_recording'));
    document.getElementById('openAutomation').addEventListener('click', () => openPermission('automation'));

    document.getElementById('refresh').addEventListener('click', async () => {
      await refreshStatus();
      await refreshGatewayState();
    });

    document.getElementById('setupChecklist').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      const checklist = await window.clientIntelligenceDesktop.agent.getSetupChecklist();
      append('system', { message: checklist.ready ? 'Desktop setup is ready' : 'Desktop setup needs attention', checklist });
    });

    document.getElementById('showAudit').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      const info = await window.clientIntelligenceDesktop.agent.getAuditInfo();
      const entries = await window.clientIntelligenceDesktop.agent.getAudit(50);
      append('system', { message: 'Local audit history', audit: { info, entries } });
    });

    document.getElementById('clearAudit').addEventListener('click', async () => {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      const info = await window.clientIntelligenceDesktop.agent.clearAudit();
      append('system', { message: 'Local audit cleared', audit: { info } });
    });

    async function openPermission(permission) {
      if (!window.clientIntelligenceDesktop) return renderStatus('Desktop bridge is not available. Load this page inside the Electron app.');
      await window.clientIntelligenceDesktop.agent.openPermissionSettings(permission);
      append('system', { message: 'Opened permission settings', permission });
    }

    refreshStatus();
    refreshGatewayState();

    function append(kind, payload) {
      const item = document.createElement('div');
      item.className = \`event \${kind}\`;
      const label = document.createElement('strong');
      label.textContent = kind;
      item.appendChild(label);

      if (payload.message) {
        const text = document.createElement('div');
        text.textContent = payload.message;
        item.appendChild(text);
      }

      const image = payload.event && payload.event.imagePreview;
      if (image) {
        const img = document.createElement('img');
        img.src = image;
        img.title = 'Click to send an input.click job at this screen coordinate';
        img.style.cursor = 'crosshair';
        img.addEventListener('click', (event) => {
          const bounds = img.getBoundingClientRect();
          const image = payload.event.image || {};
          const imageWidth = image.width || img.naturalWidth;
          const imageHeight = image.height || img.naturalHeight;
          const localX = ((event.clientX - bounds.left) / bounds.width) * imageWidth;
          const localY = ((event.clientY - bounds.top) / bounds.height) * imageHeight;
          const captureBounds = image.bounds;
          const hasCaptureBounds = captureBounds &&
            Number.isFinite(captureBounds.x) &&
            Number.isFinite(captureBounds.y) &&
            Number.isFinite(captureBounds.width) &&
            Number.isFinite(captureBounds.height) &&
            imageWidth > 0 &&
            imageHeight > 0;
          const x = hasCaptureBounds
            ? Math.round(captureBounds.x + ((localX / imageWidth) * captureBounds.width))
            : Math.round(localX);
          const y = hasCaptureBounds
            ? Math.round(captureBounds.y + ((localY / imageHeight) * captureBounds.height))
            : Math.round(localY);
          sendToolJob('input.click', { x, y });
        });
        item.appendChild(img);
      }

      const filePreview = payload.event && payload.event.filePreview;
      if (filePreview) {
        item.appendChild(renderFilePreview(filePreview));
      }

      const sources = payload.event?.type === 'job.result' &&
        Array.isArray(payload.event.result?.sources)
        ? payload.event.result.sources
        : null;
      if (sources) {
        item.appendChild(renderSourcePicker(sources));
      }

      const prompt = payload.event && payload.event.type === 'job.input_required' ? payload.event : null;
      if (prompt) {
        const promptCard = renderPromptCard(prompt);
        promptCards.set(prompt.promptId, promptCard);
        item.appendChild(promptCard);
      }

      if (payload.event?.type === 'job.result' && payload.event.jobId) {
        markPromptCardsForJob(payload.event.jobId, payload.event.status || 'resolved');
      }

      const jobId = payload.job?.jobId || payload.job?.id || payload.event?.jobId;
      if (jobId) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel Job';
        cancel.className = 'danger';
        cancel.style.marginTop = '10px';
        cancel.addEventListener('click', () => cancelJob(jobId));
        item.appendChild(cancel);
      }

      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(payload.event || payload.job || payload, null, 2);
      item.appendChild(pre);
      log.appendChild(item);
      item.scrollIntoView({ block: 'end' });
    }

    function renderFilePreview(filePreview) {
      const wrap = document.createElement('div');
      wrap.className = 'file-preview';
      const heading = document.createElement('strong');
      heading.textContent = filePreview.path || filePreview.fileName || 'File result';
      wrap.appendChild(heading);

      const meta = document.createElement('small');
      meta.textContent = 'Type: ' + filePreview.kind + (filePreview.size ? ' · Size: ' + filePreview.size + ' bytes' : '');
      wrap.appendChild(meta);

      if (filePreview.kind === 'text') {
        const content = document.createElement('pre');
        content.textContent = filePreview.content || '';
        wrap.appendChild(content);
      }

      if (filePreview.kind === 'binary' && filePreview.dataUrl) {
        const link = document.createElement('a');
        link.href = filePreview.dataUrl;
        link.download = filePreview.fileName || 'download.bin';
        link.textContent = 'Download ' + (filePreview.fileName || 'file');
        wrap.appendChild(link);
      }

      return wrap;
    }

    function renderSourcePicker(sources) {
      const wrap = document.createElement('div');
      wrap.className = 'source-picker';
      const heading = document.createElement('strong');
      heading.textContent = 'Available screen/window sources';
      wrap.appendChild(heading);

      for (const source of sources) {
        const row = document.createElement('div');
        row.className = 'source-row';
        const title = document.createElement('strong');
        title.textContent = (source.name || source.id || 'Unknown source') + ' · ' + (source.type || 'source');
        const meta = document.createElement('small');
        meta.textContent = [
          source.id ? 'ID: ' + source.id : '',
          source.displayId ? 'Display: ' + source.displayId : '',
          source.bounds ? 'Bounds: ' + source.bounds.x + ',' + source.bounds.y + ' ' + source.bounds.width + 'x' + source.bounds.height : ''
        ].filter(Boolean).join(' · ');

        const actions = document.createElement('div');
        actions.className = 'source-actions';
        const screenshot = document.createElement('button');
        screenshot.type = 'button';
        screenshot.textContent = 'Screenshot';
        screenshot.addEventListener('click', () => sendToolJob('screen.screenshot', {
          sourceId: source.id,
          format: 'jpeg',
          quality: 70
        }));

        const stream = document.createElement('button');
        stream.type = 'button';
        stream.textContent = 'Stream';
        stream.className = 'secondary';
        stream.addEventListener('click', () => sendToolJob('screen.stream', {
          sourceId: source.id,
          format: 'jpeg',
          quality: 65,
          durationMs: 15000,
          intervalMs: 3000
        }));

        actions.append(screenshot, stream);
        row.append(title, meta, actions);
        wrap.appendChild(row);
      }

      return wrap;
    }

    function renderPromptCard(prompt) {
      const wrap = document.createElement('div');
      wrap.className = 'prompt prompt-card';
      wrap.dataset.promptId = prompt.promptId || '';
      wrap.dataset.jobId = prompt.jobId || '';

      const header = document.createElement('header');
      const title = document.createElement('h3');
      title.textContent = promptTitle(prompt.kind);
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = 'Waiting';
      badge.dataset.role = 'prompt-status';
      header.append(title, badge);
      wrap.appendChild(header);

      const message = document.createElement('div');
      message.className = 'prompt-message';
      message.textContent = prompt.message || 'Response needed';
      wrap.appendChild(message);

      const meta = document.createElement('div');
      meta.className = 'prompt-meta';
      meta.textContent = [
        prompt.jobId ? 'Job: ' + prompt.jobId : '',
        prompt.promptId ? 'Prompt: ' + prompt.promptId : '',
        prompt.chatId ? 'Chat: ' + prompt.chatId : ''
      ].filter(Boolean).join(' · ');
      wrap.appendChild(meta);

      if (prompt.kind === 'secret') {
        const note = document.createElement('div');
        note.className = 'prompt-sensitive';
        note.textContent = 'Secret values are sent to the desktop agent and redacted from stored mock history.';
        wrap.appendChild(note);
      }

      const actions = document.createElement('div');
      actions.className = 'prompt-actions';

      if (prompt.kind === 'approval') {
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.textContent = 'Approve';
        approve.addEventListener('click', () => respond(prompt, { approved: true, scope: 'once' }));

        const approveSession = document.createElement('button');
        approveSession.type = 'button';
        approveSession.textContent = 'Approve Session';
        approveSession.className = 'secondary';
        approveSession.addEventListener('click', () => respond(prompt, { approved: true, scope: 'session' }));

        const approveDevice = document.createElement('button');
        approveDevice.type = 'button';
        approveDevice.textContent = 'Approve Device';
        approveDevice.className = 'secondary';
        approveDevice.addEventListener('click', () => respond(prompt, { approved: true, scope: 'device' }));

        const deny = document.createElement('button');
        deny.type = 'button';
        deny.textContent = 'Deny';
        deny.className = 'danger';
        deny.addEventListener('click', () => respond(prompt, { approved: false, scope: 'once' }));

        actions.append(approve, approveSession, approveDevice, deny);
      } else {
        const input = document.createElement('input');
        input.type = prompt.kind === 'secret' ? 'password' : 'text';
        input.placeholder = prompt.kind === 'secret' ? 'Enter secret' : 'Enter response';

        const send = document.createElement('button');
        send.type = 'button';
        send.textContent = 'Send';
        send.addEventListener('click', () => {
          const key = prompt.kind === 'secret' ? 'secret' : 'value';
          respond(prompt, { [key]: input.value });
          input.value = '';
        });

        wrap.appendChild(input);
        actions.appendChild(send);
      }

      wrap.appendChild(actions);
      return wrap;
    }

    function promptTitle(kind) {
      if (kind === 'approval') return 'Approval Required';
      if (kind === 'secret') return 'Secure Secret Request';
      return 'Response Required';
    }

    function markPromptResolved(prompt, label) {
      const card = promptCards.get(prompt.promptId);
      if (!card) return;
      card.classList.add('resolved');
      const status = card.querySelector('[data-role="prompt-status"]');
      if (status) {
        status.className = 'badge ready';
        status.textContent = label || 'Resolved';
      }
      for (const control of card.querySelectorAll('button, input')) {
        control.disabled = true;
      }
    }

    function markPromptCardsForJob(jobId, label) {
      for (const card of promptCards.values()) {
        if (card.dataset.jobId !== jobId || card.classList.contains('resolved')) continue;
        card.classList.add('resolved');
        const status = card.querySelector('[data-role="prompt-status"]');
        if (status) {
          status.className = label === 'completed' ? 'badge ready' : 'badge blocked';
          status.textContent = label === 'completed' ? 'Completed' : 'Closed';
        }
        for (const control of card.querySelectorAll('button, input')) {
          control.disabled = true;
        }
      }
    }

    async function respond(prompt, response) {
      const result = await fetch('/api/respond', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({
          ...targetRequest(false),
          jobId: prompt.jobId,
          promptId: prompt.promptId,
          response
        })
      });
      if (result.ok) {
        markPromptResolved(prompt, 'Sent');
      }
      await refreshGatewayState();
    }

    async function cancelJob(jobId) {
      if (!jobId) return;
      await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/cancel', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ reason: 'cancelled_from_mock_chat', ...targetRequest(false) })
      });
      await refreshGatewayState();
    }

    async function sendToolJob(tool, args) {
      await fetch('/api/jobs', {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ tool, args, ...targetRequest() })
      });
      await refreshGatewayState();
    }

    async function refreshStatus() {
      if (!window.clientIntelligenceDesktop) {
        renderStatus('Desktop bridge is not available. Load this page inside the Electron app to pair/connect.');
        return;
      }

      try {
        const value = await window.clientIntelligenceDesktop.agent.getStatus();
        renderStatus(value);
      } catch (error) {
        renderStatus(error.message || String(error));
      }
    }

    function renderStatus(value) {
      status.textContent = '';
      if (!value || typeof value !== 'object') {
        status.textContent = 'Desktop bridge status: ' + value;
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'status-grid';
      grid.appendChild(renderDesktopStatusCard(
        'Connection',
        statusBadge(value.connection, connectionBadgeKind(value)),
        [
          'Enabled: ' + yesNo(value.enabled),
          value.ownerUserId ? 'Owner: ' + value.ownerUserId : 'Owner: not paired',
          value.deviceId ? 'Device: ' + value.deviceId : 'Device: not paired',
          value.lastError ? 'Last error: ' + value.lastError : ''
        ].filter(Boolean)
      ));
      grid.appendChild(renderDesktopStatusCard(
        'Reconnect',
        value.nextReconnectAt ? statusBadge('retry scheduled', 'warn') : statusBadge('idle', 'ready'),
        [
          'Attempt: ' + (value.reconnectAttempt || 0),
          value.nextReconnectAt ? 'Next: ' + value.nextReconnectAt : 'Next: none',
          value.nextReconnectDelayMs ? 'Delay: ' + Math.round(value.nextReconnectDelayMs / 1000) + 's' : ''
        ].filter(Boolean)
      ));
      grid.appendChild(renderDesktopStatusCard(
        'Active Job',
        statusBadge((value.activeJobs || []).length ? 'active' : 'idle', (value.activeJobs || []).length ? 'warn' : 'ready'),
        (value.activeJobs || []).length
          ? value.activeJobs.map((job) => {
              const scope = [job.chatId, job.targetDeviceId].filter(Boolean).join(' / ');
              return (job.tool || job.jobId) + (scope ? ' (' + scope + ')' : '');
            })
          : ['No active desktop jobs']
      ));
      grid.appendChild(renderDesktopStatusCard(
        'Setup',
        statusBadge(value.launchAtLogin ? 'always-on' : 'manual', value.launchAtLogin ? 'ready' : 'warn'),
        [
          'Files: ' + value.fileAccessMode,
          'Control: ' + value.controlMode,
          'Approval: ' + value.approvalMode,
          'Shell: ' + yesNo(value.allowShell)
        ]
      ));
      grid.appendChild(renderDesktopStatusCard(
        'Permissions',
        statusBadge(permissionSummary(value.permissions), permissionsBadgeKind(value.permissions)),
        (value.permissions || []).map((permission) => permission.name + ': ' + permission.status)
      ));

      status.appendChild(grid);

      const details = document.createElement('details');
      details.className = 'status-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Raw desktop status';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(value, null, 2);
      details.append(summary, pre);
      status.appendChild(details);
    }

    function renderDesktopStatusCard(title, badge, lines) {
      const card = document.createElement('div');
      card.className = 'status-card';
      const heading = document.createElement('strong');
      heading.textContent = title + ' ';
      heading.appendChild(badge);
      card.appendChild(heading);
      for (const line of lines.length ? lines : ['none']) {
        const small = document.createElement('small');
        small.textContent = line;
        card.appendChild(small);
      }
      return card;
    }

    function statusBadge(label, kind) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + (kind || '');
      badge.textContent = label || 'unknown';
      return badge;
    }

    function connectionBadgeKind(value) {
      if (value.connection === 'connected') return 'ready';
      if (value.connection === 'disabled' || value.connection === 'error') return 'blocked';
      return 'warn';
    }

    function permissionsBadgeKind(permissions) {
      const statuses = (permissions || []).map((permission) => permission.status);
      if (statuses.some((status) => status === 'denied')) return 'blocked';
      if (statuses.some((status) => status === 'not_determined' || status === 'unknown')) return 'warn';
      return 'ready';
    }

    function permissionSummary(permissions) {
      const statuses = (permissions || []).map((permission) => permission.status);
      if (statuses.length === 0) return 'unknown';
      if (statuses.every((status) => status === 'granted')) return 'ready';
      return statuses.filter((status) => status !== 'granted').length + ' need attention';
    }

    function yesNo(value) {
      return value ? 'yes' : 'no';
    }

    async function refreshGatewayState() {
      const params = new URLSearchParams({
        ownerUserId: currentOwner(),
        chatId: currentChatId(),
      });
      const response = await fetch('/api/state?' + params.toString(), {
        headers: authedHeaders(false),
      });
      const state = await response.json();
      renderGatewayState(state);
    }

    function renderGatewayState(state) {
      gatewayState.textContent = '';
      const devices = state.devices || [];
      const jobs = state.jobs || [];
      const prompts = state.pendingPrompts || [];

      updateTargetDevices(devices);

      gatewayState.appendChild(renderStateCard('Connections', [
        'Agents: ' + state.connectedAgents,
        'Chats: ' + state.connectedChats
      ]));

      if (devices.length === 0) {
        gatewayState.appendChild(renderStateCard('Devices', ['No desktop agent connected']));
      } else {
        for (const device of devices) {
          gatewayState.appendChild(renderStateCard('Device: ' + device.displayName, [
            'Status: ' + device.status,
            'Owner: ' + device.ownerUserId,
            'ID: ' + device.id,
            'Active jobs: ' + formatActiveJobs(device),
            'Last seen: ' + device.lastSeenAt
          ]));
        }
      }

      if (jobs.length === 0) {
        gatewayState.appendChild(renderStateCard('Jobs', ['No jobs yet']));
      } else {
        for (const job of jobs.slice(0, 4)) {
          gatewayState.appendChild(renderStateCard('Job: ' + job.id, [
            'Tool: ' + job.tool,
            'Status: ' + job.status,
            job.lastMessage ? 'Message: ' + job.lastMessage : '',
            job.error ? 'Error: ' + job.error : ''
          ].filter(Boolean), job.id));
        }
      }

      if (prompts.length > 0) {
        for (const prompt of prompts) {
          gatewayState.appendChild(renderStateCard('Pending ' + promptTitle(prompt.kind), [
            prompt.message || 'Response needed',
            prompt.promptId ? 'Prompt: ' + prompt.promptId : '',
            prompt.jobId ? 'Job: ' + prompt.jobId : '',
            prompt.chatId ? 'Chat: ' + prompt.chatId : ''
          ].filter(Boolean), prompt.jobId));
        }
      }
    }

    const defaultOwner = ${jsonForInlineScript(defaultOwner)};

    function currentOwner() {
      return (targetOwner.value || defaultOwner).trim();
    }

    function currentChatId() {
      return (targetChat.value || 'mock-chat').trim();
    }

    function targetRequest(includeDevice = true) {
      const payload = { ownerUserId: currentOwner(), chatId: currentChatId() };
      if (includeDevice && targetDevice.value) payload.deviceId = targetDevice.value;
      return payload;
    }

    function updateTargetDevices(devices) {
      const owner = currentOwner();
      const selected = targetDevice.value;
      const matching = devices.filter((device) => device.ownerUserId === owner && device.status !== 'revoked');
      targetDevice.textContent = '';

      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = matching.length ? 'Auto-select owner device' : 'No paired device for owner';
      targetDevice.appendChild(auto);

      for (const device of matching) {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = (device.displayName || device.id) + ' - ' + device.status;
        targetDevice.appendChild(option);
      }

      if (matching.some((device) => device.id === selected)) {
        targetDevice.value = selected;
      }
    }

    function formatActiveJobs(device) {
      const activeJobs = Array.isArray(device.activeJobs) ? device.activeJobs : [];
      if (activeJobs.length > 0) {
        return activeJobs.map((job) => {
          const label = job.tool || job.jobId || 'unknown';
          const scope = [job.chatId, job.targetDeviceId].filter(Boolean).join(' / ');
          return scope ? label + ' (' + scope + ')' : label;
        }).join(', ');
      }
      return (device.activeJobIds || []).join(', ') || 'none';
    }

    targetOwner.addEventListener('change', refreshGatewayState);
    targetOwner.addEventListener('input', () => updateTargetDevices([]));

    function renderStateCard(title, lines, jobId) {
      const card = document.createElement('div');
      card.className = 'state-card';
      const heading = document.createElement('strong');
      heading.textContent = title;
      card.appendChild(heading);

      for (const line of lines) {
        const small = document.createElement('small');
        small.textContent = line;
        card.appendChild(small);
      }

      if (jobId) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.className = 'danger';
        cancel.style.marginTop = '8px';
        cancel.addEventListener('click', () => cancelJob(jobId));
        card.appendChild(cancel);
      }

      return card;
    }
  </script>
</body>
</html>`;
}
