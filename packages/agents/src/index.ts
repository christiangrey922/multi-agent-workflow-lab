import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentDefinitionSchema, MawlError, type AgentDefinition } from '@mawl/core';
import { parse } from 'yaml';

const isConfig = (name: string): boolean => name.endsWith('.yaml') || name.endsWith('.yml');

export class AgentRegistry {
  readonly #agents = new Map<string, AgentDefinition>();

  public register(input: unknown): AgentDefinition {
    const agent = AgentDefinitionSchema.parse(input);
    if (this.#agents.has(agent.id)) {
      throw new MawlError(`Agent already registered: ${agent.id}`, 'DUPLICATE_AGENT', {
        agentId: agent.id,
      });
    }
    this.#agents.set(agent.id, agent);
    return agent;
  }

  public get(id: string): AgentDefinition {
    const agent = this.#agents.get(id);
    if (!agent) throw new MawlError(`Unknown agent: ${id}`, 'UNKNOWN_AGENT', { agentId: id });
    return agent;
  }

  public has(id: string): boolean {
    return this.#agents.has(id);
  }

  public list(): AgentDefinition[] {
    return [...this.#agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  public selectByCapability(capability: string): AgentDefinition[] {
    return this.list().filter((agent) => agent.capabilities.includes(capability));
  }

  public inspectPermissions(
    id: string,
  ): Pick<
    AgentDefinition,
    'allowedTools' | 'allowedMcpServers' | 'permissionProfile' | 'delegationPolicy'
  > {
    const agent = this.get(id);
    return {
      allowedTools: agent.allowedTools,
      allowedMcpServers: agent.allowedMcpServers,
      permissionProfile: agent.permissionProfile,
      delegationPolicy: agent.delegationPolicy,
    };
  }

  public async loadDirectory(directory: string): Promise<AgentDefinition[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const loaded: AgentDefinition[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !isConfig(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const document = parse(await fs.readFile(fullPath, 'utf8')) as unknown;
      loaded.push(this.register(document));
    }
    return loaded;
  }
}
