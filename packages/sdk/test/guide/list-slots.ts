import { listSlots } from '@harness-store/sdk';

for (const slot of await listSlots()) {
  console.log(`${slot.name} → ${slot.resolvedModel ?? 'no model bound'}`);
}
