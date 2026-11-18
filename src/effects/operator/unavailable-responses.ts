import type { NotifyUnavailableReason } from '../../core/operator/notify-status';
import type { TestsUnavailableReason } from '../../core/operator/tests';
import type { RulesUnavailableReason } from '../../core/operator/rules';
import type { ArchitectureMapUnavailableV1 } from '../../core/operator/architecture-map';
import type { ExecutionStateUnavailableReason } from '../../core/operator/execution-state';
import type { TaskMessagesRefusal } from '../../core/operator/task-messages';
import type { BoardParentsReadFailure, BoardReadFailure } from '../../core/operator/board-read';
import type { DocsUnavailableReason } from '../../core/operator/docs';
import { NOTIFY_INSTALL_COMMAND, NOTIFY_START_COMMAND } from '../../core/decision/notify-relay-record';
import { OPERATOR_DIAGNOSTIC_ACTION } from './http-helpers';

export const OPERATOR_REGISTRY_ACTION = 'Run `rh fleet prune` to show the registry error.';
export const OPERATOR_ADOPT_ACTION = 'Adopt the repository with `rh init`, then refresh the board.';

export const NOTIFY_UNAVAILABLE: Readonly<Record<NotifyUnavailableReason, { readonly message: string; readonly next_action: string }>> = {
  notify_session_missing: { message: 'No notify relay install record exists.', next_action: `Run \`${NOTIFY_INSTALL_COMMAND}\`.` },
  notify_session_invalid: { message: 'The notify relay install record cannot be read.', next_action: `Run \`${NOTIFY_INSTALL_COMMAND}\` again.` },
  hc_unavailable: { message: 'hc did not list its terminals.', next_action: 'Check that the hc core runs, then wait for the next collection.' },
  relay_stopped: { message: 'The notify relay terminal is not live.', next_action: `Run \`${NOTIFY_START_COMMAND}\` to start it again.` },
  notify_config_unavailable: { message: 'The notify relay configuration could not be read.', next_action: `Run \`${NOTIFY_INSTALL_COMMAND}\` again, then wait for the next collection.` },
};

export const TESTS_UNAVAILABLE: Readonly<Record<TestsUnavailableReason, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  tests_pending: { status: 503, message: 'The test results are not collected yet.', next_action: 'Retry in a minute.' },
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  default_branch_unknown: { status: 503, message: 'GitHub has not named the default branch of this repository.', next_action: 'Check `gh auth status` and the GitHub remote, then wait for the next collection.' },
  github_unavailable: { status: 503, message: 'GitHub did not answer the CI run or artifact query.', next_action: 'Check `gh auth status`, then wait for the next collection.' },
  no_daily_run: { status: 503, message: 'The default branch has no completed daily CI run.', next_action: 'Wait for the scheduled CI run of the default branch.' },
  artifacts_missing: { status: 503, message: 'The newest daily CI run has no JUnit and no test projection artifact.', next_action: 'Check that the daily CI job uploads junit-daily and test-projection.' },
  artifacts_expired: { status: 503, message: 'The artifacts of the newest daily CI run have expired.', next_action: 'Wait for the next scheduled CI run.' },
  artifact_too_large: { status: 503, message: 'A test artifact is larger than the collector reads.', next_action: 'Check the size of the junit-daily and test-projection artifacts.' },
  artifact_download_failed: { status: 503, message: 'A test artifact could not be downloaded.', next_action: 'Check `gh auth status`, then wait for the next collection.' },
  tests_invalid: { status: 503, message: 'The test results failed validation.', next_action: OPERATOR_DIAGNOSTIC_ACTION },
};

export const RULES_UNAVAILABLE: Readonly<Record<RulesUnavailableReason, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  rules_pending: { status: 503, message: 'The rules status is not collected yet.', next_action: 'Retry in a minute.' },
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  rules_command_failed: { status: 503, message: 'The rules status command failed.', next_action: OPERATOR_DIAGNOSTIC_ACTION },
  rules_invalid: { status: 503, message: 'The rules status failed validation.', next_action: OPERATOR_DIAGNOSTIC_ACTION },
};

const ARCHITECTURE_MAP_RETRY = 'Wait for the next collection in 5 minutes.';
export const ARCHITECTURE_MAP_UNAVAILABLE: Readonly<Record<ArchitectureMapUnavailableV1['reason'], { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  architecture_map_pending: { status: 503, message: 'The architecture map is not collected yet.', next_action: 'Retry in a minute.' },
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  model_unavailable: {
    status: 503, message: 'The committed architecture model could not be read, and archctx gave no error code.',
    next_action: 'Check that the registered path is a git checkout with a commit. `rh fleet prune` lists registrations whose path is gone.',
  },
  archctx_error: {
    status: 503, message: 'archctx refused to read the committed architecture model.',
    next_action: 'Run `archctx export native --ref HEAD --json` in the repository. The archctx error gives its action and details.',
  },
  architecture_map_invalid: { status: 503, message: 'The architecture map failed validation.', next_action: OPERATOR_DIAGNOSTIC_ACTION },
  architecture_map_failed: { status: 503, message: 'The map process read the committed model, then failed.', next_action: `${ARCHITECTURE_MAP_RETRY} If the error stays, restart \`rh operator serve\`.` },
  architecture_map_timeout: { status: 503, message: 'The map process passed its time limit.', next_action: `${ARCHITECTURE_MAP_RETRY} If the error stays, check that git and archctx answer in the repository.` },
  architecture_map_process_failed: { status: 503, message: 'The map process did not start or gave no result.', next_action: `${ARCHITECTURE_MAP_RETRY} If the error stays, restart \`rh operator serve\`.` },
};

export const EXECUTION_UNAVAILABLE: Readonly<Record<ExecutionStateUnavailableReason, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  execution_state_pending: { status: 503, message: 'The task execution state is not collected yet.', next_action: 'Retry in a few seconds.' },
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  execution_state_unavailable: { status: 503, message: 'The task session records of this repository could not be read.', next_action: 'Wait for the next collection. If the error stays, restart `rh operator serve`.' },
};

export const TASK_MESSAGES_REFUSALS: Readonly<Record<TaskMessagesRefusal, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  task_not_found: { status: 404, message: 'The execution state of this repository has no task with this id.', next_action: 'Read the task id from the execution route of the same repository.' },
  task_unverified: { status: 409, message: 'The task has no verified session, so its inbox is not served.', next_action: 'Wait until the execution route shows the task as verified.' },
};

export const BOARD_UNAVAILABLE: Readonly<Record<BoardReadFailure, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  board_collect_failed: { status: 503, message: 'The board read failed: GitHub, the local repository or the parent issue could not be read.', next_action: 'Run `rh board --parent <n> --json` in the repository for the error.' },
  board_source_invalid: { status: 503, message: 'GitHub returned a board source that failed validation.', next_action: 'Run `rh board --parent <n> --json` in the repository for the error.' },
  board_unavailable: { status: 503, message: 'The board worker did not return a board.', next_action: 'Run `rh board --parent <n> --json` in the repository for the error.' },
  board_timeout: { status: 504, message: 'The board read did not finish in time.', next_action: 'Refresh the board and retry.' },
  board_parent_invalid: { status: 400, message: 'The board needs exactly one parent issue number.', next_action: 'Request the board with ?parent=<issue number>.' },
  board_invalid: { status: 503, message: 'The board failed validation.', next_action: 'Update repo-harness so that the operator and the board command use the same board protocol.' },
  board_pending: { status: 503, message: 'The board of this parent has no read yet. The next board observer cycle reads it.', next_action: 'Retry in a few seconds.' },
};

export const BOARD_PARENTS_UNAVAILABLE: Readonly<Record<BoardParentsReadFailure, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  registry_unavailable: BOARD_UNAVAILABLE.registry_unavailable,
  repository_not_found: BOARD_UNAVAILABLE.repository_not_found,
  parents_github_failed: { status: 503, message: 'GitHub could not list the open issues of this repository.', next_action: 'Run `rh board parents --json` in the repository for the error.' },
  parents_source_invalid: { status: 503, message: 'GitHub returned an open issue list that failed validation.', next_action: 'Run `rh board parents --json` in the repository for the error.' },
  parents_hc_failed: { status: 503, message: 'hc could not list the seat terminals of this repository.', next_action: 'Run `rh board parents --json` in the repository for the error.' },
  parents_unavailable: { status: 503, message: 'The board worker did not return a parent list.', next_action: 'Run `rh board parents --json` in the repository for the error.' },
  parents_timeout: { status: 504, message: 'The parent list read did not finish in time.', next_action: 'Refresh and retry.' },
  parents_invalid: { status: 503, message: 'The parent list failed validation.', next_action: 'Update repo-harness so that the operator and the board command use the same parent list protocol.' },
  parents_pending: { status: 503, message: 'The parent list of this repository has no read yet.', next_action: 'Retry in a few seconds.' },
};

export const DOCS_UNAVAILABLE: Readonly<Record<DocsUnavailableReason, { readonly status: number; readonly message: string; readonly next_action: string }>> = {
  docs_pending: { status: 503, message: 'The docs listing is not collected yet.', next_action: 'Retry in a minute.' },
  registry_unavailable: { status: 503, message: 'The repository registry is unreadable.', next_action: OPERATOR_REGISTRY_ACTION },
  repository_not_found: { status: 404, message: 'No registered repository has this id.', next_action: OPERATOR_ADOPT_ACTION },
  default_branch_unknown: { status: 503, message: 'GitHub has not named the default branch of this repository.', next_action: 'Check `gh auth status` and the GitHub remote, then wait for the next collection.' },
  github_remote_missing: { status: 503, message: 'No git remote points to the GitHub repository.', next_action: 'Add the GitHub remote to the repository.' },
  github_remote_ambiguous: { status: 503, message: 'More than one git remote points to the GitHub repository.', next_action: 'Keep one remote for the GitHub repository.' },
  branch_missing: { status: 503, message: 'The remote-tracking ref of the default branch does not exist.', next_action: 'Run `git fetch` in the repository.' },
  ref_invalid: { status: 503, message: 'The GitHub remote name and the default branch do not form a safe ref.', next_action: 'Either the name of the remote that points to the GitHub repository or the GitHub default branch name is the cause: it has a character outside A-Z, a-z, 0-9, ".", "_", "/" and "-", or a "..", "//", a part that starts with ".", a remote name that starts with "-", or a ".lock" end. Renaming the remote fixes only a remote name.' },
  docs_too_large: { status: 503, message: 'The docs directory has more files than the reader lists.', next_action: 'Reduce the number of files under docs/.' },
  docs_reader_unavailable: { status: 503, message: 'The docs reader is unavailable.', next_action: 'Retry after the next collection.' },
};

export const DOCS_READ_REFUSALS: Readonly<Record<string, { readonly status: number; readonly message: string }>> = {
  path_invalid: { status: 400, message: 'The path is not a repository-relative path.' },
  path_denied: { status: 403, message: 'The path is outside docs/ or names a secret-bearing file.' },
  path_escape: { status: 403, message: 'The path resolves outside docs/ through a symlink or submodule.' },
  not_found: { status: 404, message: 'The file is not in the docs listing.' },
  not_a_file: { status: 404, message: 'The path is not a regular file.' },
  too_large: { status: 413, message: 'The file is larger than 512 KiB.' },
  not_text: { status: 415, message: 'The file is not UTF-8 text.' },
};
