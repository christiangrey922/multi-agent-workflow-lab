import { type AgentDefinition, type ContextEnvelope, type JsonValue } from '@mawl/core';
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

export const detectPromptInjection = (value: string): string[] => {
  const indicators = [
    /ignore (all|any|the) previous instructions/iu,
    /reveal (the )?(system prompt|secret)/iu,
    /disable (security|permissions|policy)/iu,
  ];
  return indicators
    .filter((indicator) => indicator.test(value))
    .map((indicator) => indicator.source);
};
