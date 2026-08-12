import {
  ContextualPolicyDecisionSchema,
  createId,
  nowIso,
  type ContextualPolicyDecision,
  type JsonValue,
  type Principal,
} from '@mawl/core';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PolicyRequest {
  principal: Principal;
  operation: string;
  resource: string;
  riskLevel: RiskLevel;
  arguments?: JsonValue;
  context?: Record<string, JsonValue>;
}

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny';
  operations?: string[];
  resources?: string[];
  riskLevels?: RiskLevel[];
  principalTypes?: Principal['type'][];
  severity?: ContextualPolicyDecision['severity'];
  reason: string;
  when?: (request: PolicyRequest) => boolean;
}

export class PolicyEngine {
  readonly #decisions: ContextualPolicyDecision[] = [];

  public constructor(
    private readonly rules: readonly PolicyRule[] = defaultPolicyRules(),
    private readonly onDecision?: (decision: ContextualPolicyDecision) => void | Promise<void>,
  ) {}

  public async evaluate(request: PolicyRequest): Promise<ContextualPolicyDecision> {
    const matches = this.rules.filter((rule) => matchesRule(rule, request));
    const rule = matches.find((candidate) => candidate.effect === 'deny') ?? matches[0];
    const allow = rule?.effect === 'allow';
    const result = ContextualPolicyDecisionSchema.parse({
      decisionId: createId('policy'),
      allow,
      reason: rule?.reason ?? 'No contextual policy matched; denied by default',
      policyId: rule?.id ?? 'policy.deny_by_default',
      severity: rule?.severity ?? (allow ? 'info' : 'high'),
      metadata: {
        operation: request.operation,
        resource: request.resource,
        riskLevel: request.riskLevel,
      },
      timestamp: nowIso(),
    });
    this.#decisions.push(result);
    if (this.onDecision) await this.onDecision(result);
    return result;
  }

  public decisions(): readonly ContextualPolicyDecision[] {
    return [...this.#decisions];
  }
}

export const defaultPolicyRules = (): PolicyRule[] => [
  {
    id: 'policy.shell.destructive_deny',
    effect: 'deny',
    operations: ['shell.execute', 'tool.shell.*'],
    severity: 'critical',
    reason: 'Destructive shell command patterns are denied',
    when: (request) =>
      typeof request.arguments === 'object' &&
      request.arguments !== null &&
      !Array.isArray(request.arguments) &&
      typeof request.arguments.command === 'string' &&
      /(^|\s)(rm\s+-rf|mkfs|shutdown|reboot|dd\s+if=|format\s+[a-z]:)/iu.test(
        request.arguments.command,
      ),
  },
  {
    id: 'policy.network.local_deny',
    effect: 'deny',
    operations: ['network.*', 'tool.network.*'],
    severity: 'critical',
    reason: 'Localhost, private networks, and metadata endpoints are denied',
    when: (request) => isBlockedNetworkResource(request.resource),
  },
  {
    id: 'policy.critical_explicit_deny',
    effect: 'deny',
    riskLevels: ['critical'],
    severity: 'critical',
    reason: 'Critical operations require an application-specific allow policy',
  },
  {
    id: 'policy.high_explicit_deny',
    effect: 'deny',
    riskLevels: ['high'],
    severity: 'high',
    reason: 'High-risk operations require an application-specific allow policy',
  },
  {
    id: 'policy.low_medium_allow',
    effect: 'allow',
    riskLevels: ['low', 'medium'],
    severity: 'info',
    reason: 'Low/medium operation allowed after explicit permission check',
  },
];

const matchesRule = (rule: PolicyRule, request: PolicyRequest): boolean => {
  if (
    rule.operations &&
    !rule.operations.some((pattern) => globMatches(pattern, request.operation))
  ) {
    return false;
  }
  if (rule.resources && !rule.resources.some((pattern) => globMatches(pattern, request.resource))) {
    return false;
  }
  if (rule.riskLevels && !rule.riskLevels.includes(request.riskLevel)) return false;
  if (rule.principalTypes && !rule.principalTypes.includes(request.principal.type)) return false;
  return rule.when?.(request) ?? true;
};

const globMatches = (pattern: string, value: string): boolean => {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else {
      expression += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${expression}$`, 'u').test(value);
};

const isBlockedNetworkResource = (resource: string): boolean => {
  try {
    const hostname = new URL(resource.includes('://') ? resource : `https://${resource}`).hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '169.254.169.254' ||
      hostname.endsWith('.local') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)
    );
  } catch {
    return true;
  }
};
