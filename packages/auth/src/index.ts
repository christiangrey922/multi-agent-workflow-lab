import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ExecutionIdentitySchema,
  MawlError,
  PrincipalSchema,
  createId,
  nowIso,
  type ExecutionIdentity,
  type Principal,
} from '@mawl/core';

export type { Principal } from '@mawl/core';

export interface Credential {
  type: 'api_key' | 'bearer' | 'anonymous';
  value: string;
}

export interface Session {
  id: string;
  principal: Principal;
  createdAt: string;
  expiresAt: string | null;
}

export interface AuthContext {
  principal: Principal;
  session: Session | null;
  authenticatedAt: string;
}

export interface AuthenticationProvider {
  authenticate(credential: unknown): Promise<Principal>;
}

export interface AuthProvider extends AuthenticationProvider {
  authenticateContext(credential: Credential): Promise<AuthContext>;
}

export class StaticDevelopmentAuthProvider implements AuthenticationProvider {
  public constructor(private readonly principals: ReadonlyMap<string, Principal>) {}

  public async authenticate(credential: unknown): Promise<Principal> {
    if (typeof credential !== 'string') {
      throw new MawlError('Credential must be a string', 'AUTH_INVALID_CREDENTIAL');
    }
    const principal = this.principals.get(credential);
    if (!principal) throw new MawlError('Authentication failed', 'AUTH_FAILED');
    return PrincipalSchema.parse(structuredClone(principal));
  }
}

export interface HashedApiKeyRecord {
  id: string;
  hash: string;
  principal: Principal;
  disabled?: boolean;
}

export class LocalApiKeyAuthProvider implements AuthProvider {
  readonly #records: HashedApiKeyRecord[];

  public constructor(
    records: readonly HashedApiKeyRecord[],
    private readonly salt: string,
    private readonly sessionTtlMs = 3_600_000,
  ) {
    this.#records = records.map((record) => ({
      ...record,
      principal: PrincipalSchema.parse(record.principal),
    }));
  }

  public static hashApiKey(apiKey: string, salt: string): string {
    return createHash('sha256').update(`${salt}:${apiKey}`).digest('hex');
  }

  public async authenticate(credential: unknown): Promise<Principal> {
    const normalized: Credential =
      typeof credential === 'string'
        ? { type: 'api_key', value: credential }
        : (credential as Credential);
    return (await this.authenticateContext(normalized)).principal;
  }

  public async authenticateContext(credential: Credential): Promise<AuthContext> {
    if (credential.type !== 'api_key' || credential.value.length < 12) {
      throw new MawlError('Invalid local API key credential', 'AUTH_INVALID_CREDENTIAL');
    }
    const candidate = Buffer.from(LocalApiKeyAuthProvider.hashApiKey(credential.value, this.salt));
    const record = this.#records.find((item) => {
      const expected = Buffer.from(item.hash);
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
    if (!record || record.disabled) throw new MawlError('Authentication failed', 'AUTH_FAILED');
    const authenticatedAt = nowIso();
    const session: Session = {
      id: createId('session'),
      principal: structuredClone(record.principal),
      createdAt: authenticatedAt,
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
    };
    return { principal: structuredClone(record.principal), session, authenticatedAt };
  }
}

export interface OAuthOidcAdapter {
  createAuthorizationUrl(state: string, scopes: readonly string[]): Promise<URL>;
  exchangeAuthorizationCode(code: string, redirectUri: string): Promise<AuthContext>;
  refresh?(session: Session): Promise<AuthContext>;
}

export const createAgentExecutionIdentity = (input: {
  agentId: string;
  workflowId: string;
  taskId: string;
  executionId?: string;
  sessionId?: string | null;
}): ExecutionIdentity =>
  ExecutionIdentitySchema.parse({
    principal: {
      id: `agent:${input.agentId}`,
      type: 'agent',
      roles: ['agent'],
      capabilities: [],
      claims: { agentId: input.agentId },
      attributes: { agentId: input.agentId },
    },
    workflowId: input.workflowId,
    taskId: input.taskId,
    executionId: input.executionId ?? createId('execution'),
    sessionId: input.sessionId ?? null,
  });
