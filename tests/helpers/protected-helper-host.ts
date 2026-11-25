import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';

// Preload for a CLI subprocess only; a test file never imports it. A protected helper runs with the
// host gh at a fixed path and the account HOME. This preload gives that runtime the fixture gh and
// HOME that the subprocess environment names, so a test reaches neither the network nor a user file.
const gh = process.env.PROTECTED_HELPER_TEST_GH;
const home = process.env.PROTECTED_HELPER_TEST_HOME;
if (!gh || !home) throw new Error('protected helper preload needs PROTECTED_HELPER_TEST_GH and PROTECTED_HELPER_TEST_HOME');

const platformPath = fileURLToPath(new URL('../../src/effects/runtime/protected-helper-platform.ts', import.meta.url));
// Copy the exports before the mock: mock.module also rebinds the live namespace of the real module.
const real = { ...(await import(platformPath)) };
const resolvePlatform = real.resolveProtectedHelperPlatform;
mock.module(platformPath, () => ({
  ...real,
  resolveProtectedHelperPlatform: (options: Record<string, unknown> = {}) => resolvePlatform({ ...options, accountHome: home }),
}));

const executablePath = fileURLToPath(new URL('../../src/effects/runtime/trusted-executable.ts', import.meta.url));
const executables = { ...(await import(executablePath)) };
mock.module(executablePath, () => ({ ...executables, resolveTrustedGhExecutable: () => gh }));

const node = process.env.PROTECTED_HELPER_TEST_NODE;
if (node) {
  const candidatesPath = fileURLToPath(new URL('../../src/effects/runtime/node-candidates.ts', import.meta.url));
  const candidates = { ...(await import(candidatesPath)) };
  mock.module(candidatesPath, () => ({ ...candidates, trustedNodeCandidates: () => [node] }));
}
