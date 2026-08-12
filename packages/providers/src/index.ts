import {
  MawlError,
  asJsonValue,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@mawl/core';
import { z } from 'zod';

const ChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface OpenAICompatibleProviderOptions {
  id?: string;
  endpoint: string;
  apiKey: string;
  defaultHeaders?: Record<string, string>;
}

/**
 * An isolated example adapter for OpenAI-compatible chat-completions endpoints.
 * Credentials are injected by the caller and are never read from global state.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;

  public constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? 'openai-compatible';
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.defaultHeaders,
      },
      body: JSON.stringify({
        model: request.agent.model.model,
        temperature: request.agent.model.temperature,
        messages: [
          { role: 'system', content: request.systemPrompt },
          {
            role: 'user',
            content: JSON.stringify({
              objective: request.task.objective,
              instructions: request.task.instructions,
              input: request.task.input,
              context: request.context,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(request.task.executionBudget.maxRuntimeMs),
    });
    if (!response.ok) {
      throw new MawlError(
        `Model provider returned HTTP ${response.status}`,
        'PROVIDER_HTTP_ERROR',
        {
          status: response.status,
        },
      );
    }
    const completion = ChatCompletionSchema.parse(await response.json());
    const choice = completion.choices[0];
    if (!choice) throw new MawlError('Provider returned no choices', 'PROVIDER_EMPTY_RESPONSE');
    let output: unknown = choice.message.content;
    try {
      output = JSON.parse(choice.message.content) as unknown;
    } catch {
      // Plain text remains a valid model output.
    }
    return {
      output: asJsonValue(output),
      tokenUsage: {
        input: completion.usage?.prompt_tokens ?? 0,
        output: completion.usage?.completion_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? 'unknown',
    };
  }
}
