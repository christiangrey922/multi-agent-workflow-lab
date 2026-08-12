# Model provider integration

Local demos inject `MockModelProvider`. For an OpenAI-compatible chat-completions endpoint, inject `OpenAICompatibleProvider` explicitly:

```ts
import { OpenAICompatibleProvider } from '@mawl/providers';

const provider = new OpenAICompatibleProvider({
  endpoint: process.env.MODEL_ENDPOINT ?? '',
  apiKey: process.env.MODEL_API_KEY ?? '',
});
```

Pass `provider` to `WorkflowRuntime` or `AgentRuntime`. Load credentials from the deployment secret manager, validate missing configuration before starting, and never serialize keys into events. The adapter validates response shape and reports provider token usage; provider-specific rate limits, retries, pricing, data retention, and regional controls remain deployment responsibilities.
