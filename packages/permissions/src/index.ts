import type {
  AgentDefinition,
  ExecutionBudget,
  JsonValue,
  PermissionDecisionRecord,
  PolicyDecision,
  Principal,
} from '@mawl/core';
import { PermissionDecisionRecordSchema, clampBudget, createId, nowIso } from '@mawl/core';

export type PermissionProfile = AgentDefinition['permissionProfile'];

export interface PermissionGrant {
  id: string;
  effect: 'allow' | 'deny';
  permission: string;
  resource?: string;
  actions?: string[];
  roles?: string[];
  delegable?: boolean;
  conditions?: Record<string, JsonValue>;
}

export interface PermissionRequest {
  principal: Principal;
  permission: string;
  resource?: string;
  action?: string;
  context?: Record<string, JsonValue>;
}

const decision = (allowed: boolean, reason: string, rule: string): PolicyDecision => ({
  allowed,
  reason,
  rule,
});

export class DelegationPolicy {
  public canDelegate(agent: AgentDefinition): PolicyDecision {
    return agent.delegationPolicy.allowed
      ? decision(true, 'Delegation is enabled', 'delegation.allowed')
      : decision(false, 'Delegation is disabled', 'delegation.deny_by_default');
  }

  public canDelegateTo(parent: AgentDefinition, target: AgentDefinition): PolicyDecision {
    const targets = parent.delegationPolicy.allowedTargets;
    return targets.includes(target.id)
      ? decision(true, `Target ${target.id} is allowlisted`, 'delegation.target_allowlist')
      : decision(false, `Target ${target.id} is not allowlisted`, 'delegation.target_deny');
  }

  public canDelegateCapability(parent: AgentDefinition, capability?: string): PolicyDecision {
    if (!capability)
      return decision(true, 'No capability constraint requested', 'delegation.capability_optional');
    return parent.delegationPolicy.allowedCapabilities.includes(capability)
      ? decision(true, `Capability ${capability} is allowed`, 'delegation.capability_allowlist')
      : decision(false, `Capability ${capability} is not allowed`, 'delegation.capability_deny');
  }

  public canPassContext(kind: string): PolicyDecision {
    return kind === 'protected' || kind === 'secrets'
      ? decision(
          false,
          `${kind} context requires an explicit grant`,
          'context.protected_default_deny',
        )
      : decision(true, `${kind} context may be passed`, 'context.standard_allow');
  }

  public canPassSecret(parent: AgentDefinition, child: AgentDefinition): PolicyDecision {
    return parent.permissionProfile.allowSecrets && child.permissionProfile.allowSecrets
      ? decision(true, 'Both agents allow secret transfer', 'context.secret_explicit_allow')
      : decision(
          false,
          'Secret transfer was not explicitly allowed by both agents',
          'context.secret_deny',
        );
  }

  public canGrantTool(
    parent: AgentDefinition,
    child: AgentDefinition,
    tool: string,
  ): PolicyDecision {
    return parent.allowedTools.includes(tool) && child.allowedTools.includes(tool)
      ? decision(true, `Both agents allow ${tool}`, 'tool.intersection_allow')
      : decision(false, `Tool ${tool} is not in both allowlists`, 'tool.deny_by_default');
  }

  public canGrantPermission(
    parent: AgentDefinition,
    child: AgentDefinition,
    permission: string,
  ): PolicyDecision {
    const allowed =
      parent.permissionProfile.grants.includes(permission) &&
      child.permissionProfile.grants.includes(permission) &&
      !parent.permissionProfile.denied.includes(permission) &&
      !child.permissionProfile.denied.includes(permission);
    return allowed
      ? decision(true, `Permission ${permission} is shared`, 'permission.intersection_allow')
      : decision(false, `Permission ${permission} is not shared`, 'permission.deny_by_default');
  }

  public canDelegatePermission(parent: AgentDefinition, permission: string): PolicyDecision {
    const ownsPermission =
      parent.permissionProfile.grants.includes(permission) &&
      !parent.permissionProfile.denied.includes(permission);
    return ownsPermission
      ? decision(true, `Parent may delegate ${permission}`, 'permission.delegate_owned')
      : decision(
          false,
          `Parent cannot delegate permission it does not possess: ${permission}`,
          'permission.delegate_no_escalation',
        );
  }

  public canIncreaseBudget(
    requested: ExecutionBudget,
    parentBudget: ExecutionBudget,
  ): PolicyDecision {
    const granted = clampBudget(requested, parentBudget);
    const equal = JSON.stringify(granted) === JSON.stringify(requested);
    return equal
      ? decision(true, 'Requested budget is within the parent budget', 'budget.within_ceiling')
      : decision(false, 'A child cannot increase its parent budget', 'budget.no_escalation');
  }

  public reducePermissions(
    parent: AgentDefinition,
    child: AgentDefinition,
  ): {
    delegated: string[];
    withheld: string[];
  } {
    const requested = new Set(child.permissionProfile.grants);
    const delegated = [...requested].filter(
      (permission) => this.canGrantPermission(parent, child, permission).allowed,
    );
    const withheld = [...requested].filter((permission) => !delegated.includes(permission));
    return { delegated, withheld };
  }
}

export class PermissionEngine {
  readonly #decisions: PermissionDecisionRecord[] = [];

  public constructor(
    private readonly grants: readonly PermissionGrant[] = [],
    private readonly onDecision?: (decision: PermissionDecisionRecord) => void | Promise<void>,
  ) {}

  public async evaluate(request: PermissionRequest): Promise<PermissionDecisionRecord> {
    const matching = this.grants.filter((grant) => this.#matches(grant, request));
    const explicitDeny = matching.find((grant) => grant.effect === 'deny');
    const explicitAllow = matching.find((grant) => grant.effect === 'allow');
    const matched = explicitDeny ?? explicitAllow;
    const allowed = Boolean(explicitAllow) && !explicitDeny;
    const result = PermissionDecisionRecordSchema.parse({
      decisionId: createId('permission'),
      principal: request.principal,
      permission: request.permission,
      resource: request.resource ?? '*',
      action: request.action ?? 'use',
      allowed,
      reason: allowed
        ? `Matched explicit grant ${matched?.id ?? 'unknown'}`
        : explicitDeny
          ? `Matched explicit deny ${explicitDeny.id}`
          : 'No explicit grant matched; denied by default',
      matchedPolicy: matched?.id ?? 'permission.deny_by_default',
      timestamp: nowIso(),
    });
    this.#decisions.push(result);
    if (this.onDecision) await this.onDecision(result);
    return result;
  }

  public decisions(): readonly PermissionDecisionRecord[] {
    return [...this.#decisions];
  }

  public canDelegatePermission(
    principal: Principal,
    permission: string,
    resource = '*',
  ): PermissionDecisionRecord {
    const matching = this.grants.filter(
      (grant) =>
        grant.delegable === true &&
        grant.effect === 'allow' &&
        this.#matches(grant, { principal, permission, resource, action: 'delegate' }),
    );
    const grant = matching[0];
    const result = PermissionDecisionRecordSchema.parse({
      decisionId: createId('permission'),
      principal,
      permission,
      resource,
      action: 'delegate',
      allowed: Boolean(grant),
      reason: grant
        ? `Permission is delegable under ${grant.id}`
        : 'Principal has no delegable grant for this permission',
      matchedPolicy: grant?.id ?? 'permission.delegate_no_escalation',
      timestamp: nowIso(),
    });
    this.#decisions.push(result);
    return result;
  }

  public canUseTool(agent: AgentDefinition, tool: string): PolicyDecision {
    if (agent.permissionProfile.denied.includes(`tool:${tool}`)) {
      return decision(false, `Tool ${tool} is explicitly denied`, 'tool.explicit_deny');
    }
    return agent.allowedTools.includes(tool)
      ? decision(true, `Tool ${tool} is allowlisted`, 'tool.allowlist')
      : decision(false, `Tool ${tool} is not allowlisted`, 'tool.deny_by_default');
  }

  public canUseMcpServer(agent: AgentDefinition, server: string): PolicyDecision {
    return agent.allowedMcpServers.includes(server)
      ? decision(true, `MCP server ${server} is allowlisted`, 'mcp.allowlist')
      : decision(false, `MCP server ${server} is not allowlisted`, 'mcp.deny_by_default');
  }

  public static grantsFromAgent(agent: AgentDefinition): PermissionGrant[] {
    return [
      ...agent.permissionProfile.grants.map((permission) => ({
        id: `agent.${agent.id}.grant.${permission}`,
        effect: 'allow' as const,
        permission,
        delegable: permission.startsWith('agent.delegate') || permission === 'task:create',
      })),
      ...agent.permissionProfile.denied.map((permission) => ({
        id: `agent.${agent.id}.deny.${permission}`,
        effect: 'deny' as const,
        permission,
      })),
    ];
  }

  #matches(grant: PermissionGrant, request: PermissionRequest): boolean {
    const [grantPermission, inlineResource] = splitPermission(grant.permission);
    const [requestedPermission, requestedInlineResource] = splitPermission(request.permission);
    if (!globMatches(grantPermission, requestedPermission)) return false;
    const requestedResource = request.resource ?? requestedInlineResource ?? '*';
    const grantResource = grant.resource ?? inlineResource ?? '*';
    if (!globMatches(grantResource, requestedResource)) return false;
    if (grant.actions && request.action && !grant.actions.includes(request.action)) return false;
    if (grant.roles && !grant.roles.some((role) => request.principal.roles.includes(role))) {
      return false;
    }
    if (grant.conditions) {
      const context = request.context ?? {};
      if (
        !Object.entries(grant.conditions).every(
          ([key, expected]) => JSON.stringify(context[key]) === JSON.stringify(expected),
        )
      ) {
        return false;
      }
    }
    return true;
  }
}

const splitPermission = (permission: string): [string, string | undefined] => {
  const separator = permission.indexOf(':');
  return separator === -1
    ? [permission, undefined]
    : [permission.slice(0, separator), permission.slice(separator + 1)];
};

const globMatches = (pattern: string, value: string): boolean => {
  if (pattern === '*') return true;
  return new RegExp(`^${globToRegex(pattern)}$`, 'u').test(value);
};

const globToRegex = (pattern: string): string => {
  let output = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        output += '.*';
        index += 1;
      } else {
        output += '[^/]*';
      }
    } else {
      output += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    }
  }
  return output;
};
