// fixture-workspace-*: terminal Harnesses for the Runtime's Workspace tests, alike but for the
// Manifest's `workspace`. On start each prints, on one line, its working directory and whether it
// got HARNESS_WORKSPACE, and its value; it then waits, and exits 0 on SIGTERM.
process.on('SIGTERM', () => {
  process.exit(0);
});
setInterval(() => undefined, 60_000);

process.stdout.write(
  `FIXTURE workspace ${JSON.stringify({
    cwd: process.cwd(),
    hasWorkspace: Object.hasOwn(process.env, 'HARNESS_WORKSPACE'),
    workspace: process.env.HARNESS_WORKSPACE ?? null,
  })}\n`,
);
