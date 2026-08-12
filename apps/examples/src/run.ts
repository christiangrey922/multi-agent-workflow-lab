import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from '@mawl/agents';
import { PromptRegistry } from '@mawl/prompts';
import { WorkflowRuntime, loadWorkflowFile } from '@mawl/runtime';
import { InMemoryStore } from '@mawl/storage';
import { MockModelProvider } from '@mawl/testing';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const agents = new AgentRegistry();
const prompts = new PromptRegistry();
await agents.loadDirectory(path.join(projectRoot, 'agents'));
await prompts.loadDirectory(path.join(projectRoot, 'prompts'));

const runtime = new WorkflowRuntime({
  agents,
  prompts,
  provider: new MockModelProvider(),
  store: new InMemoryStore(),
});
const workflow = await loadWorkflowFile(path.join(projectRoot, 'workflows/research-review.yaml'));
const result = await runtime.run(workflow, { topic: 'observable delegation' });

console.log(
  JSON.stringify(
    {
      runId: result.run.runId,
      status: result.run.status,
      taskCount: result.tasks.length,
      eventCount: result.events.length,
    },
    null,
    2,
  ),
);
