import { MawlError, asJsonValue, type JsonValue, type Principal } from '@mawl/core';
import { PermissionEngine } from '@mawl/permissions';
import { SecretRedactor } from '@mawl/security';

export interface SecretReference {
  scheme: 'secret';
  name: string;
  uri: string;
}

export class SecretValue {
  readonly #value: string;

  public constructor(
    public readonly reference: SecretReference,
    value: string,
  ) {
    this.#value = value;
  }

  public revealForAuthorizedTool(): string {
    return this.#value;
  }

  public toString(): string {
    return `[SECRET:${this.reference.name}]`;
  }

  public toJSON(): string {
    return this.toString();
  }
}

export interface SecretProvider {
  get(reference: SecretReference): Promise<SecretValue>;
}

export class EnvSecretProvider implements SecretProvider {
  readonly #allowedNames: ReadonlySet<string>;

  public constructor(
    allowedNames: readonly string[],
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.#allowedNames = new Set(allowedNames);
  }

  public async get(reference: SecretReference): Promise<SecretValue> {
    if (!this.#allowedNames.has(reference.name)) {
      throw new MawlError('Secret is not allowlisted', 'SECRET_NOT_ALLOWED', {
        secret: reference.name,
      });
    }
    const value = this.environment[reference.name];
    if (!value) {
      throw new MawlError('Secret is unavailable', 'SECRET_NOT_FOUND', {
        secret: reference.name,
      });
    }
    return new SecretValue(reference, value);
  }
}

export class SecretManager {
  readonly #resolvedValues = new Set<string>();

  public constructor(
    private readonly provider: SecretProvider,
    private readonly permissions: PermissionEngine,
    private readonly redactor = new SecretRedactor(),
  ) {}

  public async resolveForTool(referenceUri: string, principal: Principal): Promise<SecretValue> {
    const reference = parseSecretReference(referenceUri);
    const decision = await this.permissions.evaluate({
      principal,
      permission: `secret.read.${reference.name}`,
      resource: reference.name,
      action: 'read',
    });
    if (!decision.allowed) {
      throw new MawlError('Secret permission denied', 'PERMISSION_DENIED', {
        permission: decision.permission,
      });
    }
    const secret = await this.provider.get(reference);
    this.#resolvedValues.add(secret.revealForAuthorizedTool());
    return secret;
  }

  public sanitize(value: unknown): { value: JsonValue; redactions: string[] } {
    const json = asJsonValue(value);
    const result = this.redactor.redact(json, [...this.#resolvedValues]);
    return { value: result.value, redactions: result.paths };
  }

  public containsSecret(value: unknown): boolean {
    const serialized = JSON.stringify(value);
    return [...this.#resolvedValues].some(
      (secret) => secret.length > 0 && serialized.includes(secret),
    );
  }
}

export const parseSecretReference = (uri: string): SecretReference => {
  const match = /^secret:\/\/([A-Z][A-Z0-9_]*)$/u.exec(uri);
  if (!match?.[1]) throw new MawlError('Invalid secret reference', 'INVALID_SECRET_REFERENCE');
  return { scheme: 'secret', name: match[1], uri };
};
