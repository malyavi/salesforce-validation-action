import {repositoryRequest} from './github.mjs';

/**
 * Handing the org on to a pull request whose validation was dropped.
 *
 * The job that validates holds a concurrency group, so validations take the org
 * one at a time. GitHub keeps one running and one pending job per group, and a
 * job that arrives while another is pending cancels it. Pull requests pushed
 * close together therefore lose all but the first and the last, and the ones
 * lost are left with a cancelled validation and nothing on the pull request to
 * say so.
 *
 * Run as the last step of the validating job, while that job still holds the
 * group, a re-run started here waits in the pending slot and begins the moment
 * this job ends. Each validation then passes the org on again, so the lost ones
 * are validated one after another.
 *
 * What counts as dropped is narrow on purpose. The validating job was cancelled
 * and never ran a step, and every other job of its run passed or was skipped. A
 * person cancelling the run cancels those too, and a validation that started and
 * was stopped has steps, so neither is re-run.
 */

const PASSED = ['success', 'skipped'];

/**
 * Says what the validation of one run is doing.
 *
 * @param {Array<{ name: string, status: string, conclusion: string|null, steps?: Array<object> }>} jobs The run's jobs
 * @param {string} jobName Display name of the validating job
 * @return {'active'|'dropped'|'other'} `active` while the job is queued or running, since it hands the org on when
 *         it ends, `dropped` when it was cancelled before it started, otherwise `other`
 */
export function classifyValidation(jobs, jobName) {
  const validating = jobs.find((job) => job.name === jobName);
  if (!validating) {
    return 'other';
  }
  if (validating.status !== 'completed') {
    return 'active';
  }

  const neverStarted = (validating.steps ?? []).length === 0;
  const othersPassed = jobs
    .filter((job) => job !== validating)
    .every((job) => PASSED.includes(job.conclusion));
  return validating.conclusion === 'cancelled' && neverStarted && othersPassed ? 'dropped' : 'other';
}

/**
 * The workflow file a run belongs to, from `GITHUB_WORKFLOW_REF`.
 *
 * @param {string|undefined} workflowRef Value of `GITHUB_WORKFLOW_REF`, `owner/repo/.github/workflows/file.yml@ref`
 * @return {string} The file name, or an empty string when the reference is absent
 */
export function workflowFile(workflowRef) {
  return (workflowRef ?? '').split('@')[0].split('/').pop() ?? '';
}

/**
 * Finds the pull requests into a branch whose latest run has a dropped
 * validation, unless a validation is already waiting or running, which will hand
 * the org on itself.
 *
 * @param {object} options What to look for
 * @param {Function} options.request Calls the repository's API, as `repositoryRequest` does
 * @param {string} options.base Branch the pull requests target
 * @param {string} options.workflow Workflow file the validation runs from
 * @param {string} options.jobName Display name of the validating job
 * @param {number} options.currentRunId This run, left out of the search
 * @return {Promise<{ active: object|null, dropped: Array<{ pr: object, run: object }> }>} What was found
 */
export async function findDropped({request, base, workflow, jobName, currentRunId}) {
  const pulls = await request(`/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
  const dropped = [];

  for (const pr of pulls.filter((pull) => !pull.draft)) {
    const {workflow_runs: runs} = await request(
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=20`
    );
    const latest = [...runs].sort((a, b) => b.run_number - a.run_number)[0];
    if (!latest || latest.id === currentRunId) {
      continue;
    }

    const {jobs} = await request(`/actions/runs/${latest.id}/jobs?per_page=100`);
    const verdict = classifyValidation(jobs, jobName);
    if (verdict === 'active') {
      return {active: {pr, run: latest}, dropped: []};
    }
    if (verdict === 'dropped') {
      dropped.push({pr, run: latest});
    }
  }
  return {active: null, dropped};
}

/**
 * Re-runs the validation of the pull request that has waited longest.
 *
 * Only one is re-run: a second would take the pending slot and cancel the
 * first, which is the loss being undone. The re-run is of failed jobs only, so
 * the jobs that already passed are not repeated; GitHub counts a cancelled job
 * as failed for this.
 *
 * @param {object} options What to look for
 * @param {Function} [options.request] Calls the repository's API
 * @param {string} options.base Branch the pull requests target
 * @param {string} options.workflow Workflow file the validation runs from
 * @param {string} options.jobName Display name of the validating job
 * @param {number} options.currentRunId This run, left out of the search
 * @param {boolean} [options.dryRun] Report what would be re-run and re-run nothing
 * @return {Promise<{ outcome: 'waiting'|'none'|'would-requeue'|'requeued', pr?: object, run?: object, more?: number }>} What was done
 */
export async function requeueDropped({request = repositoryRequest, dryRun = false, ...search}) {
  const {active, dropped} = await findDropped({request, ...search});
  if (active) {
    return {outcome: 'waiting', pr: active.pr, run: active.run};
  }
  if (dropped.length === 0) {
    return {outcome: 'none'};
  }

  // The one that has waited longest.
  dropped.sort((a, b) => new Date(a.run.created_at) - new Date(b.run.created_at));
  const [next] = dropped;
  const found = {pr: next.pr, run: next.run, more: dropped.length - 1};

  if (dryRun) {
    return {outcome: 'would-requeue', ...found};
  }
  await request(`/actions/runs/${next.run.id}/rerun-failed-jobs`, {method: 'POST'});
  return {outcome: 'requeued', ...found};
}
