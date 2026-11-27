import type { BoardItemV1, BoardPullRequestV1, BoardV1 } from './board';

/** The pull requests of an item in every state, newest number first. */
export function itemPullRequests(board: BoardV1, item: BoardItemV1): readonly BoardPullRequestV1[] {
  return board.pull_requests.filter(pr => item.pull_requests.includes(pr.number)).slice().sort((left, right) => right.number - left.number);
}

/** Pull requests on `board` whose head branch is `branch`, newest number first. */
export function branchPullRequests(board: BoardV1, branch: string): readonly BoardPullRequestV1[] {
  return board.pull_requests.filter(pr => pr.head_ref === branch).slice().sort((left, right) => right.number - left.number);
}

/** The newest open pull request in `prs`, else the newest merged one (input must be newest-first). */
export function newestActivePullRequest(prs: readonly BoardPullRequestV1[]): BoardPullRequestV1 | null {
  return prs.find(pr => pr.state === 'open') ?? prs.find(pr => pr.state === 'merged') ?? null;
}

/** The pull request a row shows: the newest open one, else the newest merged one. */
export function primaryPullRequest(board: BoardV1, item: BoardItemV1): BoardPullRequestV1 | null {
  return newestActivePullRequest(itemPullRequests(board, item));
}
