import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function cleanRoomEnvironment(workspace: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.ARCHCONTEXT_LOCAL_STORE_PATH;
  return {
    ...env,
    HOME: join(workspace, 'host-home'),
    ARCHCONTEXT_STATE_DIR: join(workspace, 'runtime-state'),
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
    BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9',
  };
}

const DAEMON_ARTIFACT = /^(?:archctxd(?:\.json|\.pid|\.sock)|daemon\.(?:pid|sock)|.*\.sock)$/u;

/** Fails closed if an in-process archctx run leaves any daemon control, PID or socket file behind. */
export function assertNoDaemonArtifacts(stateDir: string): void {
  if (!existsSync(stateDir)) return;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (DAEMON_ARTIFACT.test(entry.name)) {
        throw new Error(`unexpected daemon artifact in clean-room state dir: ${fullPath}`);
      }
      if (entry.isDirectory()) walk(fullPath);
    }
  };
  walk(stateDir);
}

export function finishCleanRoom(input: {
  cleanup: () => void;
  failure?: { error: unknown };
}): void {
  try {
    input.cleanup();
  } catch (error) {
    if (input.failure) throw new AggregateError([input.failure.error, error], 'clean-room operation and cleanup failed; inspect retained workspace');
    throw error;
  }
}
