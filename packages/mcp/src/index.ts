import { promises as fs } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MawlError, asJsonValue, type AgentDefinition, type JsonValue } from '@mawl/core';
import { PermissionEngine } from '@mawl/permissions';
import { PolicyEngine } from '@mawl/policy';
import { ToolRegistry, type ToolDefinition, type ToolRiskType } from '@mawl/tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const McpServerDefinitionSchema = z.object({
  id: z.string().min(1),
  transport: z.enum(['stdio', 'streamable_http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.url().optional(),
  env: z.record(z.string(), z.string()).default({}),
  permissions: z.array(z.string().min(1)).default([]),
  trusted: z.boolean().default(false),
  allowedTools: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
}

export interface McpConnection {
  readonly serverId: string;
  readonly definition: McpServerDefinition;
  status(): McpConnectionStatus;
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  listResources(): Promise<McpResourceDescriptor[]>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  callTool(name: string, argumentsValue: JsonValue): Promise<JsonValue>;
  readResource(uri: string): Promise<JsonValue>;
  getPrompt(name: string, argumentsValue?: Record<string, string>): Promise<JsonValue>;
}

export interface McpSdkClientLike {
  connect(transport: StdioClientTransport | StreamableHTTPClientTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<unknown>;
  listResources(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  readResource(input: { uri: string }): Promise<unknown>;
  getPrompt(input: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
}

const ToolListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().default(''),
      inputSchema: z.unknown().default({}),
    }),
  ),
});
const ResourceListSchema = z.object({
  resources: z.array(
    z.object({
      uri: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
});
const PromptListSchema = z.object({
  prompts: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});
const McpCallResultSchema = z
  .object({
    content: z.array(z.unknown()).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .refine((value) => value.content !== undefined || value.structuredContent !== undefined, {
    message: 'MCP response has neither content nor structuredContent',
  });

export class OfficialMcpConnection implements McpConnection {
  public readonly serverId: string;
  #status: McpConnectionStatus = 'disconnected';

  public constructor(
    public readonly definition: McpServerDefinition,
    private readonly client: McpSdkClientLike = new Client({
      name: 'multi-agent-workflow-lab',
      version: '0.1.0',
    }),
  ) {
    this.serverId = definition.id;
  }

  public status(): McpConnectionStatus {
    return this.#status;
  }

  public async connect(): Promise<void> {
    this.#status = 'connecting';
    try {
      const transport =
        this.definition.transport === 'stdio'
          ? new StdioClientTransport({
              command: required(this.definition.command, 'stdio MCP server command'),
              args: this.definition.args,
              env: this.definition.env,
            })
          : new StreamableHTTPClientTransport(
              new URL(required(this.definition.url, 'MCP server URL')),
            );
      await withTimeout(this.client.connect(transport), this.definition.timeoutMs);
      this.#status = 'connected';
    } catch (error) {
      this.#status = 'failed';
      throw new MawlError(
        error instanceof Error ? error.message : 'MCP connection failed',
        'MCP_CONNECTION_ERROR',
      );
    }
  }

  public async close(): Promise<void> {
    await this.client.close();
    this.#status = 'closed';
  }

  public async listTools(): Promise<McpToolDescriptor[]> {
    this.#assertConnected();
    const result = ToolListSchema.parse(
      await withTimeout(this.client.listTools(), this.definition.timeoutMs),
    );
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: asJsonValue(tool.inputSchema),
    }));
  }

  public async listResources(): Promise<McpResourceDescriptor[]> {
    this.#assertConnected();
    const resources = ResourceListSchema.parse(
      await withTimeout(this.client.listResources(), this.definition.timeoutMs),
    ).resources;
    return resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }));
  }

  public async listPrompts(): Promise<McpPromptDescriptor[]> {
    this.#assertConnected();
    const prompts = PromptListSchema.parse(
      await withTimeout(this.client.listPrompts(), this.definition.timeoutMs),
    ).prompts;
    return prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description ? { description: prompt.description } : {}),
    }));
  }

  public async callTool(name: string, argumentsValue: JsonValue): Promise<JsonValue> {
    this.#assertConnected();
    const raw = await withTimeout(
      this.client.callTool({
        name,
        arguments:
          typeof argumentsValue === 'object' &&
          argumentsValue !== null &&
          !Array.isArray(argumentsValue)
            ? argumentsValue
            : { value: argumentsValue },
      }),
      this.definition.timeoutMs,
    );
    const result = McpCallResultSchema.safeParse(raw);
    if (!result.success) {
      throw new MawlError('Malformed MCP tool response', 'MCP_MALFORMED_RESPONSE', {
        issues: asJsonValue(result.error.issues),
      });
    }
    return asJsonValue(result.data);
  }

  public async readResource(uri: string): Promise<JsonValue> {
    this.#assertConnected();
    return asJsonValue(
      await withTimeout(this.client.readResource({ uri }), this.definition.timeoutMs),
    );
  }

  public async getPrompt(
    name: string,
    argumentsValue?: Record<string, string>,
  ): Promise<JsonValue> {
    this.#assertConnected();
    return asJsonValue(
      await withTimeout(
        this.client.getPrompt({ name, ...(argumentsValue ? { arguments: argumentsValue } : {}) }),
        this.definition.timeoutMs,
      ),
    );
  }

  #assertConnected(): void {
    if (this.#status !== 'connected') {
      throw new MawlError(`MCP server ${this.serverId} is not connected`, 'MCP_NOT_CONNECTED');
    }
  }
}

export class McpClientManager {
  readonly #connections = new Map<string, McpConnection>();

  public register(
    definition: McpServerDefinition,
    connection: McpConnection = new OfficialMcpConnection(definition),
  ): void {
    if (this.#connections.has(definition.id)) {
      throw new MawlError(`Duplicate MCP server: ${definition.id}`, 'DUPLICATE_MCP_SERVER');
    }
    this.#connections.set(definition.id, connection);
  }

  public get(serverId: string): McpConnection {
    const connection = this.#connections.get(serverId);
    if (!connection) throw new MawlError(`Unknown MCP server: ${serverId}`, 'UNKNOWN_MCP_SERVER');
    return connection;
  }

  public inspect(): {
    serverId: string;
    transport: McpServerDefinition['transport'];
    trusted: boolean;
    permissions: string[];
    status: McpConnectionStatus;
  }[] {
    return [...this.#connections.values()].map((connection) => ({
      serverId: connection.serverId,
      transport: connection.definition.transport,
      trusted: connection.definition.trusted,
      permissions: connection.definition.permissions,
      status: connection.status(),
    }));
  }

  public async connect(serverId: string): Promise<void> {
    await this.get(serverId).connect();
  }

  public async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#connections.values()].map(async (connection) => connection.close()),
    );
  }

  public async registerTools(serverId: string, registry: ToolRegistry): Promise<ToolDefinition[]> {
    const connection = this.get(serverId);
    const remoteTools = await connection.listTools();
    const adapted = remoteTools
      .filter(
        (tool) =>
          !connection.definition.allowedTools ||
          connection.definition.allowedTools.includes(tool.name),
      )
      .map((tool) => McpToolAdapter.adapt(connection, tool));
    for (const tool of adapted) registry.register(tool);
    return adapted;
  }
}

export const McpToolAdapter = {
  adapt(connection: McpConnection, tool: McpToolDescriptor): ToolDefinition {
    const risk = classifyMcpToolRisk(tool.name, tool.description);
    return {
      id: `mcp.${connection.serverId}.${tool.name}`,
      name: `mcp.${connection.serverId}.${tool.name}`,
      description: tool.description,
      provider: `mcp:${connection.serverId}`,
      inputSchema: schemaFromJsonSchema(tool.inputSchema),
      requiredPermissions: connection.definition.permissions,
      riskTypes: risk.types,
      riskLevel: risk.level,
      timeoutMs: connection.definition.timeoutMs,
      sandboxPolicy: 'none',
      metadata: {
        serverId: connection.serverId,
        trusted: connection.definition.trusted,
        source: 'mcp',
      },
      handler: async (argumentsValue) => connection.callTool(tool.name, argumentsValue),
    };
  },
};

export const McpResourceAdapter = {
  read: (connection: McpConnection, uri: string): Promise<JsonValue> =>
    connection.readResource(uri),
};

export const McpPromptAdapter = {
  get(
    connection: McpConnection,
    name: string,
    argumentsValue?: Record<string, string>,
  ): Promise<JsonValue> {
    return connection.getPrompt(name, argumentsValue);
  },
};

export const loadMcpServerFile = async (filename: string): Promise<McpServerDefinition> =>
  McpServerDefinitionSchema.parse(parseYaml(await fs.readFile(filename, 'utf8')));

export interface McpConnector {
  readonly serverId: string;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, argumentsValue: JsonValue): Promise<JsonValue>;
}

export class McpRegistry {
  readonly #servers = new Map<string, McpConnector>();

  public constructor(
    private readonly permissions = new PermissionEngine(),
    private readonly policy = new PolicyEngine(),
  ) {}

  public register(connector: McpConnector): void {
    if (this.#servers.has(connector.serverId)) {
      throw new MawlError(`Duplicate MCP server: ${connector.serverId}`, 'DUPLICATE_MCP_SERVER');
    }
    this.#servers.set(connector.serverId, connector);
  }

  public async call(
    agent: AgentDefinition,
    serverId: string,
    toolName: string,
    argumentsValue: unknown,
  ): Promise<JsonValue> {
    const permission = this.permissions.canUseMcpServer(agent, serverId);
    if (!permission.allowed) {
      throw new MawlError(permission.reason, 'MCP_PERMISSION_DENIED', { serverId, toolName });
    }
    const policy = await this.policy.evaluate({
      principal: {
        id: `agent:${agent.id}`,
        type: 'agent',
        roles: ['agent'],
        capabilities: agent.capabilities,
        claims: { agentId: agent.id },
        attributes: { agentId: agent.id },
      },
      operation: `mcp.${serverId}.${toolName}`,
      resource: serverId,
      riskLevel: 'low',
      arguments: asJsonValue(argumentsValue),
    });
    if (!policy.allow) throw new MawlError(policy.reason, 'MCP_POLICY_DENIED');
    const server = this.#servers.get(serverId);
    if (!server) throw new MawlError(`Unknown MCP server: ${serverId}`, 'UNKNOWN_MCP_SERVER');
    return server.callTool(toolName, asJsonValue(argumentsValue));
  }
}

export class InMemoryMcpConnector implements McpConnector {
  public readonly serverId: string;
  readonly #tools = new Map<string, (argumentsValue: JsonValue) => Promise<JsonValue>>();

  public constructor(serverId: string) {
    this.serverId = serverId;
  }

  public addTool(name: string, handler: (argumentsValue: JsonValue) => Promise<JsonValue>): void {
    this.#tools.set(name, handler);
  }

  public async listTools(): Promise<McpToolDescriptor[]> {
    return [...this.#tools.keys()].map((name) => ({ name, description: '', inputSchema: {} }));
  }

  public async callTool(name: string, argumentsValue: JsonValue): Promise<JsonValue> {
    const handler = this.#tools.get(name);
    if (!handler) throw new MawlError(`Unknown MCP tool: ${name}`, 'UNKNOWN_MCP_TOOL');
    return handler(argumentsValue);
  }
}

const classifyMcpToolRisk = (
  name: string,
  description: string,
): { level: 'low' | 'medium' | 'high' | 'critical'; types: ToolRiskType[] } => {
  const combined = `${name} ${description}`;
  if (/delete|destroy|credential|secret|admin/iu.test(combined)) {
    return { level: 'critical', types: ['secret', 'admin', 'external_side_effect'] };
  }
  if (/shell|exec|command|write|create|update/iu.test(combined)) {
    return { level: 'high', types: ['execute', 'write', 'external_side_effect'] };
  }
  if (/network|http|fetch|search/iu.test(combined)) {
    return { level: 'medium', types: ['network', 'read'] };
  }
  return { level: 'low', types: ['read'] };
};

const schemaFromJsonSchema = (schema: JsonValue): z.ZodType =>
  z.unknown().superRefine((value, context) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        context.addIssue({ code: 'custom', message: 'Expected object arguments' });
        return;
      }
      const requiredFields = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === 'string')
        : [];
      for (const field of requiredFields) {
        if (!(field in value)) {
          context.addIssue({ code: 'custom', message: `Missing required field: ${field}` });
        }
      }
    }
  });

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new MawlError(`Missing ${label}`, 'INVALID_MCP_CONFIGURATION');
  return value;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new MawlError(`MCP operation exceeded ${timeoutMs}ms`, 'MCP_TIMEOUT')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
