import {
  PromptInjectionSignalSchema,
  nowIso,
  sha256,
  type AgentDefinition,
  type ContextEnvelope,
  type JsonValue,
  type PromptInjectionCategory,
  type PromptInjectionSeverity,
  type PromptInjectionSignal,
  type PromptInjectionSource,
} from '@mawl/core';
import { DelegationPolicy } from '@mawl/permissions';

export interface ContextTransferResult {
  passed: ContextEnvelope;
  omitted: string[];
}

export class ContextBoundary {
  public constructor(private readonly policy = new DelegationPolicy()) {}

  public transfer(
    context: ContextEnvelope,
    parent: AgentDefinition,
    child: AgentDefinition,
  ): ContextTransferResult {
    const allowSecrets = this.policy.canPassSecret(parent, child).allowed;
    const omitted = [...context.explicitlyOmitted];
    if (Object.keys(context.protected).length > 0) omitted.push('protected');
    if (!allowSecrets && Object.keys(context.secrets).length > 0) omitted.push('secrets');
    return {
      passed: {
        public: structuredClone(context.public),
        workflow: structuredClone(context.workflow),
        taskLocal: structuredClone(context.taskLocal),
        protected: {},
        secrets: allowSecrets ? structuredClone(context.secrets) : {},
        explicitlyOmitted: [...new Set(omitted)],
      },
      omitted: [...new Set(omitted)],
    };
  }
}

export class SecretRedactor {
  public redact(
    value: JsonValue,
    secrets: readonly string[],
  ): { value: JsonValue; paths: string[] } {
    const paths: string[] = [];
    const walk = (current: JsonValue, path: string): JsonValue => {
      if (typeof current === 'string') {
        let output = current;
        for (const secret of secrets.filter(Boolean)) {
          if (output.includes(secret)) {
            output = output.replaceAll(secret, '[REDACTED]');
            paths.push(path);
          }
        }
        return output;
      }
      if (Array.isArray(current))
        return current.map((item, index) => walk(item, `${path}[${index}]`));
      if (current && typeof current === 'object') {
        return Object.fromEntries(
          Object.entries(current).map(([key, item]) => [key, walk(item, `${path}.${key}`)]),
        );
      }
      return current;
    };
    return { value: walk(value, '$'), paths: [...new Set(paths)] };
  }
}

export interface PromptInjectionScanInput {
  content: string;
  source: PromptInjectionSource;
  workflowId?: string;
  taskId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

interface InjectionIndicator {
  id: string;
  category: Exclude<PromptInjectionCategory, 'unknown_suspicious_instruction'>;
  pattern: RegExp;
  severity: PromptInjectionSeverity;
}

const INDICATORS: readonly InjectionIndicator[] = [
  {
    id: 'override.ignore_previous_instructions',
    category: 'instruction_override',
    pattern:
      /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier)\s+(?:instructions?|rules?|directives?)\b/iu,
    severity: 'high',
  },
  {
    id: 'override.disregard_previous_rules',
    category: 'instruction_override',
    pattern:
      /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier)\s+(?:instructions?|rules?|directives?)\b/iu,
    severity: 'high',
  },
  {
    id: 'override.forget_earlier_rules',
    category: 'instruction_override',
    pattern:
      /\bforget\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier)\s+(?:instructions?|rules?|directives?)\b/iu,
    severity: 'high',
  },
  {
    id: 'override.supersede_prior_instructions',
    category: 'instruction_override',
    pattern:
      /\b(?:new|following)\s+instructions?\s+(?:override|supersede|replace)\s+(?:the\s+)?(?:previous|prior|earlier)\s+(?:instructions?|rules?|directives?)\b/iu,
    severity: 'high',
  },
  {
    id: 'authority.system_message_claim',
    category: 'authority_impersonation',
    pattern: /\b(?:this|the\s+following)\s+is\s+(?:an?\s+)?(?:official\s+)?system\s+message\b/iu,
    severity: 'warning',
  },
  {
    id: 'authority.privileged_identity_claim',
    category: 'authority_impersonation',
    pattern:
      /\bi\s+am\s+(?:now\s+)?(?:the\s+)?(?:system\s+administrator|root\s+orchestrator|root\s+agent|superuser)\b/iu,
    severity: 'warning',
  },
  {
    id: 'authority.privileged_directive',
    category: 'authority_impersonation',
    pattern: /\b(?:system|developer|administrator|root)\s+(?:instruction|directive|override)\s*:/iu,
    severity: 'warning',
  },
  {
    id: 'policy.disable_controls',
    category: 'policy_disable_attempt',
    pattern:
      /\b(?:disable|turn\s+off)\s+(?:all\s+)?(?:permission\s+checks?|policy\s+(?:checks?|enforcement)|security\s+(?:checks?|validation)|safety\s+checks?)\b/iu,
    severity: 'high',
  },
  {
    id: 'policy.bypass_controls',
    category: 'policy_disable_attempt',
    pattern:
      /\b(?:bypass|skip|circumvent)\s+(?:the\s+)?(?:permission|policy|security|safety)\s+(?:checks?|validation|controls?|enforcement)\b/iu,
    severity: 'high',
  },
  {
    id: 'policy.do_not_enforce',
    category: 'policy_disable_attempt',
    pattern:
      /\b(?:do\s+not|don't)\s+(?:apply|enforce|run)\s+(?:the\s+)?(?:permission|policy|security|safety)\s+(?:checks?|validation|controls?|rules?)\b/iu,
    severity: 'high',
  },
  {
    id: 'secret.reveal_protected_data',
    category: 'secret_exfiltration_request',
    pattern:
      /\b(?:show|reveal|print|return|expose|provide|dump)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?(?:api[- ]?keys?|credentials?|secrets?|environment\s+variables?|protected\s+context|system\s+prompt)\b/iu,
    severity: 'high',
  },
  {
    id: 'secret.transmit_protected_data',
    category: 'secret_exfiltration_request',
    pattern:
      /\b(?:send|upload|transmit|forward)\s+(?:all\s+)?(?:the\s+)?(?:api[- ]?keys?|credentials?|secrets?|environment\s+variables?|protected\s+context)\b/iu,
    severity: 'high',
  },
  {
    id: 'secret.read_process_environment',
    category: 'secret_exfiltration_request',
    pattern: /\b(?:read|dump|print|return)\s+(?:all\s+)?(?:of\s+)?process\.env\b/iu,
    severity: 'high',
  },
  {
    id: 'tool.activate_privileged_tool',
    category: 'tool_activation_request',
    pattern:
      /\b(?:execute|run|invoke|activate|call)\s+(?:the\s+)?(?:shell|terminal|shell\s+command|system\s+command|privileged\s+tool|admin(?:istrative)?\s+tool)\b/iu,
    severity: 'warning',
  },
  {
    id: 'tool.execute_supplied_command',
    category: 'tool_activation_request',
    pattern: /\b(?:execute|run)\s+(?:this\s+|the\s+following\s+)?command\s*:/iu,
    severity: 'warning',
  },
] as const;

const UNKNOWN_INDICATOR = {
  id: 'unknown.covert_agent_instruction',
  category: 'unknown_suspicious_instruction',
  pattern:
    /\b(?:you|the\s+agent|assistant)\s+(?:must|should|need\s+to|are\s+required\s+to)\b.{0,120}\b(?:without\s+telling|do\s+not\s+mention|keep\s+(?:this|it)\s+hidden|regardless\s+of\s+(?:the\s+)?(?:rules|policy))\b/iu,
  severity: 'warning',
} as const;

const SEVERITY_RANK: Readonly<Record<PromptInjectionSeverity, number>> = {
  info: 0,
  warning: 1,
  high: 2,
};

/**
 * Deterministically detects prompt-injection indicators in untrusted text.
 * Signals are diagnostic evidence only and never authorize or block an operation.
 */
export class PromptInjectionScanner {
  public constructor(private readonly clock: () => string = nowIso) {}

  public scan(input: PromptInjectionScanInput): PromptInjectionSignal[] {
    const normalized = normalizeForScanning(input.content);
    if (!normalized) return [];

    const matches = INDICATORS.filter((indicator) => {
      const match = indicator.pattern.exec(normalized);
      return match !== null && !isExplanatoryReference(normalized, match.index);
    });
    const effectiveMatches =
      matches.length > 0
        ? matches
        : (() => {
            const match = UNKNOWN_INDICATOR.pattern.exec(normalized);
            return match && !isExplanatoryReference(normalized, match.index)
              ? [UNKNOWN_INDICATOR]
              : [];
          })();
    if (effectiveMatches.length === 0) return [];

    const contentHash = sha256(input.content);
    const matchedIndicators = effectiveMatches.map((indicator) => indicator.id);
    const categories = [
      ...new Set(effectiveMatches.map((indicator) => indicator.category)),
    ] as PromptInjectionCategory[];
    const severity = effectiveMatches.reduce<PromptInjectionSeverity>(
      (highest, indicator) =>
        SEVERITY_RANK[indicator.severity] > SEVERITY_RANK[highest] ? indicator.severity : highest,
      'info',
    );
    const stableIdentity = sha256(
      `${input.source}\n${contentHash}\n${matchedIndicators.join('\n')}`,
    ).slice(0, 24);

    return [
      PromptInjectionSignalSchema.parse({
        id: `prompt-injection:${stableIdentity}`,
        source: input.source,
        categories,
        severity,
        matchedIndicators,
        contentHash,
        detectedAt: this.clock(),
      }),
    ];
  }
}

const normalizeForScanning = (content: string): string =>
  content.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();

const isExplanatoryReference = (content: string, matchIndex: number): boolean => {
  const boundary = Math.max(
    content.lastIndexOf('.', matchIndex - 1),
    content.lastIndexOf('?', matchIndex - 1),
    content.lastIndexOf('!', matchIndex - 1),
    content.lastIndexOf('\n', matchIndex - 1),
  );
  const prefix = content
    .slice(boundary + 1, matchIndex)
    .trim()
    .replace(/^[\s[{("']*(?:[\w.-]+["']?\s*:\s*)?["']*/u, '');
  return /^(?:please\s+)?(?:explain|define|describe|discuss|analy[sz]e|summarize|document|write\s+(?:documentation|a\s+guide|an\s+article))\b/iu.test(
    prefix,
  );
};

/** Backward-compatible indicator IDs for existing tool-output metadata. */
export const detectPromptInjection = (value: string): string[] =>
  new PromptInjectionScanner()
    .scan({ content: value, source: 'tool_output' })
    .flatMap((signal) => signal.matchedIndicators);
