import { ApprovalGrant, ApprovalMode, DesktopAgentSettings, PromptResponse } from './types';

export function normalizeApprovalGrants(value: unknown): ApprovalGrant[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((grant): grant is ApprovalGrant => (
      grant &&
      typeof grant === 'object' &&
      typeof (grant as ApprovalGrant).tool === 'string' &&
      (grant as ApprovalGrant).tool.length > 0 &&
      (grant as ApprovalGrant).scope === 'device' &&
      typeof (grant as ApprovalGrant).grantedAt === 'string'
    ))
    .map((grant) => ({
      tool: grant.tool,
      scope: 'device',
      grantedAt: grant.grantedAt,
    }));
}

export function hasDeviceApprovalGrant(settings: DesktopAgentSettings, tool: string): boolean {
  return settings.deviceApprovalGrants.some((grant) => grant.tool === tool && grant.scope === 'device');
}

export function withDeviceApprovalGrant(
  settings: DesktopAgentSettings,
  tool: string,
  grantedAt = new Date().toISOString(),
): ApprovalGrant[] {
  return [
    ...settings.deviceApprovalGrants.filter((grant) => grant.tool !== tool),
    {
      tool,
      scope: 'device',
      grantedAt,
    },
  ];
}

export function shouldRequestApproval(input: {
  approvalMode: ApprovalMode;
  isApprovalWorthy: boolean;
  hasSessionApproval: boolean;
  hasDeviceApproval: boolean;
}): boolean {
  if (input.approvalMode === 'always_for_owner' && !input.isApprovalWorthy) return false;
  if (input.approvalMode === 'session' && input.hasSessionApproval) return false;
  if (input.approvalMode === 'device' && input.hasDeviceApproval) return false;
  if (input.approvalMode === 'ask_every_time') return true;

  return input.isApprovalWorthy;
}

export function approvalGrantScope(
  response: PromptResponse,
  approvalMode: ApprovalMode,
): 'once' | 'session' | 'device' {
  if (response.scope) return response.scope;
  if (approvalMode === 'session' || approvalMode === 'device') return approvalMode;
  return 'once';
}
