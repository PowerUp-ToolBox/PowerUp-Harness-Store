import { getContext, NotInHarnessStoreError } from '@harness-store/sdk';

try {
  const context = getContext();
  console.log(`${context.harnessId} ${context.harnessVersion} on ${context.platform}`);
  console.log(`Language: ${context.locale}`);
  console.log(`Data Directory: ${context.dataDir}`);
  console.log(`Workspace: ${context.workspace ?? 'none'}`);
} catch (error) {
  // Started from a shell rather than by Harness Store: the message says what to do instead.
  if (!(error instanceof NotInHarnessStoreError)) throw error;
  console.error(error.message);
  process.exit(1);
}
