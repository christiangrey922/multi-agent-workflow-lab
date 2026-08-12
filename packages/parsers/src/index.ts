import { MawlError, TaskSchema, asJsonValue, type JsonValue, type Task } from '@mawl/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export type InputFormat = 'json' | 'yaml' | 'markdown' | 'text' | 'structured_task';

export interface NormalizedInput {
  sourceType: InputFormat;
  raw: string;
  parsed: JsonValue;
  metadata: Record<string, JsonValue>;
  warnings: string[];
}

export interface RegisteredInputParser {
  readonly id: InputFormat;
  parse(content: string): NormalizedInput;
}

abstract class BaseInputParser implements RegisteredInputParser {
  public abstract readonly id: InputFormat;
  protected abstract parseValue(content: string): JsonValue;

  public parse(content: string): NormalizedInput {
    return {
      sourceType: this.id,
      raw: content,
      parsed: this.parseValue(content),
      metadata: { byteLength: Buffer.byteLength(content, 'utf8') },
      warnings: [],
    };
  }
}

export class JSONInputParser extends BaseInputParser {
  public readonly id = 'json' as const;
  protected parseValue(content: string): JsonValue {
    try {
      return asJsonValue(JSON.parse(content));
    } catch (error) {
      throw new MawlError(
        error instanceof Error ? error.message : 'Invalid JSON input',
        'INPUT_PARSE_ERROR',
      );
    }
  }
}

export class YAMLInputParser extends BaseInputParser {
  public readonly id = 'yaml' as const;
  protected parseValue(content: string): JsonValue {
    try {
      return asJsonValue(parseYaml(content));
    } catch (error) {
      throw new MawlError(
        error instanceof Error ? error.message : 'Invalid YAML input',
        'INPUT_PARSE_ERROR',
      );
    }
  }
}

export class MarkdownInputParser extends BaseInputParser {
  public readonly id = 'markdown' as const;
  protected parseValue(content: string): JsonValue {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content);
    const body = frontmatter ? content.slice(frontmatter[0].length) : content;
    const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gmu)].map((match) => ({
      level: match[1]?.length ?? 1,
      text: match[2] ?? '',
    }));
    return {
      frontmatter: frontmatter?.[1] ? asJsonValue(parseYaml(frontmatter[1])) : {},
      body,
      headings,
    };
  }
}

export class PlainTextInputParser extends BaseInputParser {
  public readonly id = 'text' as const;
  protected parseValue(content: string): JsonValue {
    return content;
  }
}

export class StructuredTaskInputParser extends BaseInputParser {
  public readonly id = 'structured_task' as const;
  protected parseValue(content: string): JsonValue {
    const candidate: unknown = content.trimStart().startsWith('{')
      ? (JSON.parse(content) as unknown)
      : parseYaml(content);
    return asJsonValue(TaskSchema.parse(candidate));
  }

  public parseTask(content: string): Task {
    return TaskSchema.parse(this.parse(content).parsed);
  }
}

export class InputParserRegistry {
  readonly #parsers = new Map<InputFormat, RegisteredInputParser>();

  public constructor(parsers: readonly RegisteredInputParser[] = defaultParsers()) {
    for (const parser of parsers) this.register(parser);
  }

  public register(parser: RegisteredInputParser): void {
    if (this.#parsers.has(parser.id)) {
      throw new MawlError(`Duplicate input parser: ${parser.id}`, 'DUPLICATE_INPUT_PARSER');
    }
    this.#parsers.set(parser.id, parser);
  }

  public parse(
    content: string,
    format: InputFormat,
    expectedSchema?: z.ZodType<JsonValue>,
  ): NormalizedInput {
    const parser = this.#parsers.get(format);
    if (!parser) throw new MawlError(`Unknown input parser: ${format}`, 'UNKNOWN_INPUT_PARSER');
    const normalized = parser.parse(content);
    if (expectedSchema) {
      const result = expectedSchema.safeParse(normalized.parsed);
      if (!result.success) {
        throw new MawlError('Input does not satisfy workflow schema', 'INPUT_SCHEMA_ERROR', {
          issues: asJsonValue(result.error.issues),
        });
      }
      normalized.parsed = result.data;
    }
    return normalized;
  }
}

export interface TaskProposal {
  kind: 'proposal';
  objective: string;
  requestedCapabilities: string[];
  suggestedAgent: string | null;
  constraints: string[];
  requestedTools: string[];
  executable: false;
}

export class NaturalLanguageTaskParser {
  public propose(content: string): TaskProposal {
    const requestedCapabilities = [
      ...content.matchAll(/(?:capability|kh\u1ea3 n\u0103ng):\s*([\w.-]+)/giu),
    ].map((match) => match[1] ?? '');
    const requestedTools = [...content.matchAll(/(?:tool|c\u00f4ng c\u1ee5):\s*([\w.-]+)/giu)].map(
      (match) => match[1] ?? '',
    );
    const suggestedAgent = /(?:agent|t\u00e1c nh\u00e2n):\s*([\w.-]+)/iu.exec(content)?.[1] ?? null;
    return {
      kind: 'proposal',
      objective: content.trim(),
      requestedCapabilities: requestedCapabilities.filter(Boolean),
      suggestedAgent,
      constraints: [],
      requestedTools: requestedTools.filter(Boolean),
      executable: false,
    };
  }
}

export class InputParser {
  readonly #registry = new InputParserRegistry();

  public parse(content: string, format: 'json' | 'yaml' | 'text'): JsonValue {
    return this.#registry.parse(content, format).parsed;
  }

  public parseWithSchema<T>(
    content: string,
    format: 'json' | 'yaml' | 'text',
    schema: z.ZodType<T>,
  ): T {
    return schema.parse(this.parse(content, format));
  }
}

const defaultParsers = (): RegisteredInputParser[] => [
  new JSONInputParser(),
  new YAMLInputParser(),
  new MarkdownInputParser(),
  new PlainTextInputParser(),
  new StructuredTaskInputParser(),
];
