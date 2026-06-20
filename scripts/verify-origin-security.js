#!/usr/bin/env node

const {
  getURLHost,
  isAllowedGatewayURL,
  isTrustedAppURL,
  parseTrustedHosts,
} = require('../dist/agent/origin');

const appHost = getURLHost('https://clientintelligence.ai');
const trustedHosts = new Set([
  appHost,
  `www.${appHost}`,
  ...parseTrustedHosts('localhost:47391,127.0.0.1:47391,example.test:3000'),
]);

assert(isTrustedAppURL('https://clientintelligence.ai/dashboard', trustedHosts), 'canonical HTTPS app URL should be trusted');
assert(isTrustedAppURL('https://www.clientintelligence.ai/dashboard', trustedHosts), 'www HTTPS app URL should be trusted');
assert(isTrustedAppURL('http://localhost:47391/', trustedHosts), 'trusted localhost dev URL should be trusted');
assert(isTrustedAppURL('http://127.0.0.1:47391/', trustedHosts), 'trusted loopback dev URL should be trusted');

assert(!isTrustedAppURL('http://clientintelligence.ai/dashboard', trustedHosts), 'plain HTTP production URL should not be trusted');
assert(!isTrustedAppURL('https://clientintelligence.ai.evil.test/dashboard', trustedHosts), 'lookalike host should not be trusted');
assert(!isTrustedAppURL('http://example.test:3000/', trustedHosts), 'non-loopback HTTP trusted host should not be trusted');
assert(!isTrustedAppURL('file:///tmp/client.html', trustedHosts), 'file URLs should not be trusted');
assert(!isTrustedAppURL('javascript:alert(1)', trustedHosts), 'javascript URLs should not be trusted');
assert(!isTrustedAppURL('not a url', trustedHosts), 'invalid URLs should not be trusted');

assert(isAllowedGatewayURL('wss://clientintelligence.ai/api/desktop-agent/connect'), 'production gateway should allow wss');
assert(isAllowedGatewayURL('https://clientintelligence.ai'), 'production gateway should allow https polling');
assert(isAllowedGatewayURL('ws://localhost:47391/desktop-agent/connect'), 'local gateway should allow localhost ws');
assert(isAllowedGatewayURL('ws://127.0.0.1:47391/desktop-agent/connect'), 'local gateway should allow IPv4 loopback ws');
assert(isAllowedGatewayURL('ws://[::1]:47391/desktop-agent/connect'), 'local gateway should allow IPv6 loopback ws');
assert(isAllowedGatewayURL('http://127.0.0.1:47391'), 'local gateway should allow HTTP polling on loopback');
assert(!isAllowedGatewayURL('ws://clientintelligence.ai/api/desktop-agent/connect'), 'production gateway should reject plain ws');
assert(!isAllowedGatewayURL('http://clientintelligence.ai'), 'production gateway should reject plain http');
assert(!isAllowedGatewayURL('file:///tmp/gateway.sock'), 'gateway should reject file URLs');

console.log('Origin security verification passed');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
