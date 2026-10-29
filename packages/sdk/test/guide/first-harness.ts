import { createInterface } from 'node:readline';
import { createOpenAIClient, getContext, Slots, SlotUnboundError } from '@harness-store/sdk';

const { harnessVersion, workspace } = getContext();
const openai = createOpenAIClient();

console.log(`First Harness ${harnessVersion}. Ask a question; Ctrl-D quits.`);
if (workspace !== undefined) console.log(`Workspace: ${workspace}`);

for await (const question of createInterface({ input: process.stdin, output: process.stdout })) {
  if (question.trim() === '') continue;
  try {
    const stream = await openai.chat.completions.create({
      model: Slots.default,
      messages: [{ role: 'user', content: question }],
      stream: true,
    });
    let model = '';
    for await (const chunk of stream) {
      model = chunk.model;
      process.stdout.write(chunk.choices[0]?.delta.content ?? '');
    }
    process.stdout.write(`\n(${model})\n`);
  } catch (error) {
    const unbound = SlotUnboundError.from(error);
    console.log(
      unbound === undefined
        ? `The model call failed: ${error instanceof Error ? error.message : String(error)}`
        : `No model is bound to the "${unbound.slot}" Model Slot. Bind one on the Models page of Harness Store.`,
    );
  }
}
