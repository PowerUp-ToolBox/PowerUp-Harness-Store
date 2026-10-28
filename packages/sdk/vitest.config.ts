import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests stub the launch environment with vi.stubEnv; every test starts from the real one.
    unstubEnvs: true,
  },
});
