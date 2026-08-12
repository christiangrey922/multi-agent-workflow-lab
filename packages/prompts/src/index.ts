import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DetailedPromptAssemblySchema,
  MawlError,
  PromptDefinitionSchema,
  asJsonValue,
  createId,
  sha256,
  type AgentDefinition,
  type DetailedPromptAssembly,
  type JsonValue,
  type PromptLayer,
  type PromptDefinition,
} from '@mawl/core';
import { parse } from 'yaml';

export interface RegisteredPrompt extends PromptDefinition {
  contentHash: string;
}

export class PromptRegistry {
  readonly #prompts = new Map<string, RegisteredPrompt>();

  public register(input: unknown): RegisteredPrompt {
    const parsed = PromptDefinitionSchema.parse(input);
    const computedHash = sha256(parsed.content);
    if (parsed.contentHash && parsed.contentHash !== computedHash) {
      throw new MawlError(
        'Prompt content hash does not match declared hash',
        'PROMPT_HASH_MISMATCH',
        {
          promptId: parsed.id,
          version: parsed.version,
        },
      );
    }
    const key = this.#key(parsed.id, parsed.version);
    const existing = this.#prompts.get(key);
    if (existing && existing.contentHash !== computedHash) {
      throw new MawlError(
        `Prompt ${parsed.id}@${parsed.version} was modified without a version change`,
        'PROMPT_VERSION_CONFLICT',
        { promptId: parsed.id, version: parsed.version },
      );
    }
    const prompt: RegisteredPrompt = { ...parsed, contentHash: computedHash };
    this.#prompts.set(key, prompt);
    return prompt;
  }

  public get(id: string, version?: string): RegisteredPrompt {
    if (version) {
      const prompt = this.#prompts.get(this.#key(id, version));
      if (!prompt) throw new MawlError(`Unknown prompt: ${id}@${version}`, 'UNKNOWN_PROMPT');
      return prompt;
    }
    const candidates = this.list().filter((prompt) => prompt.id === id);
    const latest = candidates.at(-1);
    if (!latest) throw new MawlError(`Unknown prompt: ${id}`, 'UNKNOWN_PROMPT');
    return latest;
  }

  public list(): RegisteredPrompt[] {
    return [...this.#prompts.values()].sort((a, b) =>
      `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`),
    );
  }

  public render(
    id: string,
    version: string,
    input: Record<string, JsonValue>,
  ): RegisteredPrompt & { rendered: string } {
    const prompt = this.get(id, version);
    for (const required of Object.keys(prompt.inputSchema)) {
      if (!(required in input)) {
        throw new MawlError(`Missing prompt input: ${required}`, 'MISSING_PROMPT_INPUT');
      }
    }
    const rendered = prompt.content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
      const value = input[key];
      return value === undefined
        ? match
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    });
    return { ...prompt, rendered };
  }

  public renderStrict(
    id: string,
    version: string,
    input: Record<string, JsonValue>,
    maxVariableBytes = 32_768,
  ): RegisteredPrompt & { rendered: string } {
    const prompt = this.get(id, version);
    const expected = new Set(Object.keys(prompt.inputSchema));
    const unexpected = Object.keys(input).filter((key) => !expected.has(key));
    if (unexpected.length > 0) {
      throw new MawlError(
        `Unexpected prompt variables: ${unexpected.join(', ')}`,
        'UNEXPECTED_PROMPT_VARIABLE',
      );
    }
    for (const [key, type] of Object.entries(prompt.inputSchema)) {
      const value = input[key];
      if (value === undefined) {
        throw new MawlError(`Missing prompt input: ${key}`, 'MISSING_PROMPT_INPUT');
      }
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxVariableBytes) {
        throw new MawlError(`Prompt variable is oversized: ${key}`, 'PROMPT_VARIABLE_OVERSIZED');
      }
      if (!matchesDeclaredType(value, type)) {
        throw new MawlError(`Invalid prompt variable type for ${key}`, 'INVALID_PROMPT_VARIABLE');
      }
    }
    const rendered = this.render(id, version, input).rendered;
    if (/\{\{\s*[\w.]+\s*\}\}/u.test(rendered)) {
      throw new MawlError('Unresolved prompt placeholder', 'UNRESOLVED_PROMPT_PLACEHOLDER');
    }
    return { ...prompt, rendered };
  }

  public async loadDirectory(directory: string): Promise<RegisteredPrompt[]> {
    const loaded: RegisteredPrompt[] = [];
    const visit = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          loaded.push(this.register(parse(await fs.readFile(fullPath, 'utf8')) as unknown));
        }
      }
    };
    await visit(directory);
    return loaded;
  }

  #key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}

export interface SystemPromptProcessorOptions {
  runtimePolicy: string;
  securityPolicy: string;
  maxVariableBytes?: number;
}

export interface SystemPromptInput {
  agent: AgentDefinition;
  variables: Record<string, JsonValue>;
  workflowInstructions?: string;
  taskInstructions?: string;
  runtimeContext?: JsonValue;
  userInput?: JsonValue;
  toolOutput?: JsonValue[];
  mcpOutput?: JsonValue[];
  childOutput?: JsonValue[];
}

export class SystemPromptProcessor {
  readonly #options: Readonly<SystemPromptProcessorOptions>;

  public constructor(
    private readonly registry: PromptRegistry,
    options: SystemPromptProcessorOptions,
  ) {
    this.#options = Object.freeze({ ...options });
  }

  public process(input: SystemPromptInput): DetailedPromptAssembly {
    const agentPrompt = this.registry.renderStrict(
      input.agent.systemPrompt,
      input.agent.systemPromptVersion,
      input.variables,
      this.#options.maxVariableBytes,
    );
    const layers: PromptLayer[] = [
      trustedLayer('runtime.root', 'runtime_policy', this.#options.runtimePolicy, 'runtime'),
      trustedLayer('security.root', 'security_policy', this.#options.securityPolicy, 'security'),
      {
        id: agentPrompt.id,
        source: 'agent_system',
        trust: 'trusted',
        content: agentPrompt.rendered,
        version: agentPrompt.version,
        hash: agentPrompt.contentHash,
        provenance: `prompt-registry:${agentPrompt.id}@${agentPrompt.version}`,
      },
    ];
    if (input.workflowInstructions) {
      layers.push(
        trustedLayer('workflow.instructions', 'workflow', input.workflowInstructions, 'workflow'),
      );
    }
    if (input.taskInstructions) {
      layers.push(trustedLayer('task.instructions', 'task', input.taskInstructions, 'task'));
    }
    appendUntrusted(layers, 'user.input', 'user_input', input.userInput);
    for (const [index, output] of (input.toolOutput ?? []).entries()) {
      appendUntrusted(layers, `tool.output.${index}`, 'tool_output', output);
    }
    for (const [index, output] of (input.mcpOutput ?? []).entries()) {
      appendUntrusted(layers, `mcp.output.${index}`, 'mcp_output', output);
    }
    for (const [index, output] of (input.childOutput ?? []).entries()) {
      appendUntrusted(layers, `child.output.${index}`, 'child_output', output);
    }
    if (input.runtimeContext !== undefined) {
      layers.push(
        trustedLayer(
          'runtime.context',
          'runtime_context',
          JSON.stringify(asJsonValue(input.runtimeContext)),
          'runtime',
        ),
      );
    }
    const rendered = layers
      .map(
        (layer) =>
          `--- layer:${layer.id} source:${layer.source} trust:${layer.trust} ---\n${layer.content}`,
      )
      .join('\n\n');
    return DetailedPromptAssemblySchema.parse({
      assemblyId: createId('prompt-assembly'),
      agentId: input.agent.id,
      promptIds: layers.map((layer) => layer.id),
      versions: layers.map((layer) => layer.version),
      hashes: layers.map((layer) => layer.hash),
      layers,
      rendered,
      renderedHash: sha256(rendered),
      variables: input.variables,
      redactions: [],
    });
  }
}

const trustedLayer = (
  id: string,
  source: PromptLayer['source'],
  content: string,
  provenance: string,
): PromptLayer => ({
  id,
  source,
  trust: 'trusted',
  content,
  version: '1.0.0',
  hash: sha256(content),
  provenance,
});

const appendUntrusted = (
  layers: PromptLayer[],
  id: string,
  source: PromptLayer['source'],
  value: JsonValue | undefined,
): void => {
  if (value === undefined) return;
  const serialized = JSON.stringify(asJsonValue(value));
  const content = `<untrusted-data source="${source}">\n${serialized}\n</untrusted-data>`;
  layers.push({
    id,
    source,
    trust: 'untrusted',
    content,
    version: '1.0.0',
    hash: sha256(content),
    provenance: id,
  });
};

const matchesDeclaredType = (value: JsonValue, type: string): boolean => {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
};
