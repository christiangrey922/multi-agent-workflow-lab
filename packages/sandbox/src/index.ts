import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MawlError, createId } from '@mawl/core';

const execFileAsync = promisify(execFile);

export type NetworkEnforcement = 'enforced' | 'best_effort' | 'unsupported';

export interface FilesystemPolicy {
  read: string[];
  write: string[];
  deny: string[];
}

export type NetworkPolicy =
  { mode: 'deny_all' } | { mode: 'allow'; hosts: string[]; denyPrivateNetworks: boolean };

export interface SandboxExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envAllowlist: string[];
  timeout: number;
  maxOutputBytes: number;
  filesystemPolicy: FilesystemPolicy;
  networkPolicy: NetworkPolicy;
  signal?: AbortSignal;
}

export interface SandboxExecutionResult {
  executionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputBytes: number;
  networkEnforcement: NetworkEnforcement;
}

export interface SandboxProvider {
  readonly id: string;
  readonly isolation: 'process' | 'container' | 'microvm';
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export class RestrictedLocalSandbox implements SandboxProvider {
  public readonly id = createId('sandbox-provider');
  public readonly isolation = 'process' as const;
  readonly #allowedCommands: ReadonlySet<string>;

  public constructor(
    private readonly workspaceRoot: string,
    allowedCommands: readonly string[],
  ) {
    this.#allowedCommands = new Set(allowedCommands);
  }

  public async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (!this.#allowedCommands.has(request.command)) {
      throw new MawlError(`Command is not allowlisted: ${request.command}`, 'SANDBOX_ERROR');
    }
    const cwd = await this.assertPathAllowed(request.cwd, 'read', request.filesystemPolicy);
    const env = Object.fromEntries(
      Object.entries(request.env).filter(([key]) => request.envAllowlist.includes(key)),
    );
    const start = performance.now();
    try {
      const result = await execFileAsync(request.command, request.args, {
        cwd,
        timeout: request.timeout,
        maxBuffer: request.maxOutputBytes,
        env,
        signal: request.signal,
        encoding: 'utf8',
      });
      const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (outputBytes > request.maxOutputBytes) {
        throw new MawlError('Sandbox output exceeded configured limit', 'SANDBOX_OUTPUT_OVERFLOW');
      }
      return {
        executionId: createId('sandbox-execution'),
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: performance.now() - start,
        outputBytes,
        networkEnforcement: 'best_effort',
      };
    } catch (error) {
      if (error instanceof MawlError) throw error;
      const detail = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (detail.killed || detail.message.includes('timed out')) {
        throw new MawlError('Sandbox execution timed out', 'TIMEOUT');
      }
      if (detail.message.includes('maxBuffer')) {
        throw new MawlError('Sandbox output exceeded configured limit', 'SANDBOX_OUTPUT_OVERFLOW');
      }
      throw new MawlError(detail.message, 'SANDBOX_ERROR', {
        exitCode: typeof detail.code === 'number' ? detail.code : 1,
      });
    }
  }

  public async assertPathAllowed(
    candidate: string,
    operation: 'read' | 'write',
    policy: FilesystemPolicy,
  ): Promise<string> {
    const decoded = decodePath(candidate);
    const absolute = path.resolve(this.workspaceRoot, decoded);
    if (!isInside(this.workspaceRoot, absolute)) {
      throw new MawlError('Path traversal or absolute path bypass detected', 'PATH_TRAVERSAL');
    }
    const existing = await nearestExistingPath(absolute);
    const realExisting = await fs.realpath(existing);
    if (!isInside(await fs.realpath(this.workspaceRoot), realExisting)) {
      throw new MawlError('Symlink escape detected', 'SYMLINK_ESCAPE');
    }
    if (policy.deny.some((pattern) => matchesPath(this.workspaceRoot, pattern, absolute))) {
      throw new MawlError('Filesystem policy explicitly denied the path', 'FILESYSTEM_DENIED');
    }
    const allow = operation === 'read' ? policy.read : policy.write;
    if (!allow.some((pattern) => matchesPath(this.workspaceRoot, pattern, absolute))) {
      throw new MawlError('Filesystem path is outside the allowlist', 'FILESYSTEM_DENIED');
    }
    return absolute;
  }
}

export interface DockerSandboxOptions {
  image: string;
  dockerExecutable?: string;
}

export class DockerSandbox implements SandboxProvider {
  public readonly id = createId('docker-sandbox-provider');
  public readonly isolation = 'container' as const;

  public constructor(private readonly options: DockerSandboxOptions) {}

  public async available(): Promise<boolean> {
    try {
      await execFileAsync(
        this.options.dockerExecutable ?? 'docker',
        ['version', '--format', '{{.Server.Version}}'],
        {
          timeout: 2_000,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  public async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    void request;
    throw new MawlError(
      `Docker adapter for image ${this.options.image} is optional and not enabled by default`,
      'SANDBOX_UNAVAILABLE',
    );
  }
}

export interface SandboxCommand {
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface Sandbox {
  readonly id: string;
  run(command: SandboxCommand): Promise<SandboxResult>;
  destroy(): Promise<void>;
}

export class RestrictedProcessSandbox implements Sandbox {
  public readonly id = createId('sandbox');
  readonly #directory: string;
  readonly #provider: RestrictedLocalSandbox;
  #destroyed = false;

  private constructor(directory: string, allowedExecutables: readonly string[]) {
    this.#directory = directory;
    this.#provider = new RestrictedLocalSandbox(directory, allowedExecutables);
  }

  public static async create(
    allowedExecutables: readonly string[],
  ): Promise<RestrictedProcessSandbox> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mawl-sandbox-'));
    return new RestrictedProcessSandbox(directory, allowedExecutables);
  }

  public async run(command: SandboxCommand): Promise<SandboxResult> {
    if (this.#destroyed) throw new MawlError('Sandbox is destroyed', 'SANDBOX_DESTROYED');
    const result = await this.#provider.execute({
      command: command.executable,
      args: command.args,
      cwd: '.',
      env: {},
      envAllowlist: [],
      timeout: command.timeoutMs,
      maxOutputBytes: 1_048_576,
      filesystemPolicy: { read: ['**'], write: ['**'], deny: [] },
      networkPolicy: { mode: 'deny_all' },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }

  public async destroy(): Promise<void> {
    if (!this.#destroyed) {
      await fs.rm(this.#directory, { recursive: true, force: true });
      this.#destroyed = true;
    }
  }
}

const decodePath = (value: string): string => {
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes('\0')) throw new MawlError('NUL byte in path', 'PATH_TRAVERSAL');
  return decoded;
};

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const nearestExistingPath = async (candidate: string): Promise<string> => {
  let current = candidate;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new MawlError('No existing parent path', 'FILESYSTEM_DENIED');
      current = parent;
    }
  }
};

const matchesPath = (root: string, pattern: string, candidate: string): boolean => {
  const normalizedPattern = pattern.replace(/^workspace\//u, '');
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  if (normalizedPattern === '**') return true;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/u, '');
    return relative === prefix || relative.startsWith(`${prefix}/`);
  }
  return relative === normalizedPattern;
};
