import { createOpenAIClient, Slots, SlotUnboundError } from '@harness-store/sdk';

const openai = createOpenAIClient();

try {
  const completion = await openai.chat.completions.create({
    model: Slots.default,
    messages: [{ role: 'user', content: 'Say hello in five words' }],
  });
  console.log(completion.choices[0]?.message.content);
  // The provider/model the User bound to the Slot, e.g. ollama/qwen3:8b.
  console.log(`Answered by ${completion.model}`);
} catch (error) {
  const unbound = SlotUnboundError.from(error);
  if (unbound === undefined) throw error;
  console.log(
    `No model is bound to the "${unbound.slot}" Model Slot. Bind one on the Models page of Harness Store.`,
  );
}
