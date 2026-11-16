import {describe, it}                                     from 'node:test';
import assert                                             from 'node:assert/strict';
import {classifyValidation, requeueDropped, workflowFile} from '../lib/requeue.mjs';

/**
 * Handing the org on to a pull request whose validation was dropped.
 *
 * A wrong answer here either leaves a pull request with no validation, which is
 * the loss this exists to undo, or re-runs one that should be left alone, which
 * costs a validation nobody wanted. The API is a fake: what is under test is
 * which pull request is chosen and what is sent for it.
 */

const JOB = 'Validate metadata';

/** The jobs of a run in which the validating job was dropped from the queue. */
const droppedJobs = [
  {name: 'Triage changes', status: 'completed', conclusion: 'success', steps: [{}]},
  {name: 'Jest (LWC)', status: 'completed', conclusion: 'skipped', steps: []},
  {name: JOB, status: 'completed', conclusion: 'cancelled', steps: []}
];

/**
 * A copy of the jobs with one changed.
 *
 * @param {string} name Name of the job to change
 * @param {object} changes Fields to replace
 * @param {Array<object>} [jobs] Jobs to start from
 * @return {Array<object>} The jobs
 */
function with_(name, changes, jobs = droppedJobs) {
  return jobs.map((job) => (job.name === name ? {...job, ...changes} : job));
}

describe('classifyValidation', () => {
  it('calls a validation cancelled before it ran a step, with every other job passed or skipped, dropped', () => {
    assert.equal(classifyValidation(droppedJobs, JOB), 'dropped');
  });

  it('calls a validation that is queued or running active, since it hands the org on when it ends', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
      assert.equal(classifyValidation(with_(JOB, {status, conclusion: null}), JOB), 'active', status);
    }
  });

  it('leaves a validation that had started alone, even when it was cancelled', () => {
    assert.equal(classifyValidation(with_(JOB, {steps: [{}, {}]}), JOB), 'other');
  });

  it('leaves a run alone when another of its jobs failed or was cancelled, as it is when a person cancels the run', () => {
    assert.equal(classifyValidation(with_('Jest (LWC)', {conclusion: 'failure'}), JOB), 'other');
    assert.equal(classifyValidation(with_('Triage changes', {conclusion: 'cancelled'}), JOB), 'other');
  });

  it('leaves a validation that passed or failed alone', () => {
    assert.equal(classifyValidation(with_(JOB, {conclusion: 'success', steps: [{}]}), JOB), 'other');
    assert.equal(classifyValidation(with_(JOB, {conclusion: 'failure', steps: [{}]}), JOB), 'other');
  });

  it('answers other when the run has no job of that name, as when triage skipped it', () => {
    assert.equal(classifyValidation(droppedJobs, 'Validate'), 'other');
    assert.equal(classifyValidation([], JOB), 'other');
  });
});

describe('workflowFile', () => {
  it('reads the file name from the workflow reference', () => {
    assert.equal(
      workflowFile('octo/repo/.github/workflows/pr-validation.yml@refs/pull/12/merge'),
      'pr-validation.yml'
    );
  });

  it('answers an empty string when there is no reference', () => {
    assert.equal(workflowFile(undefined), '');
    assert.equal(workflowFile(''), '');
  });
});

describe('requeueDropped', () => {
  const search = {base: 'main', workflow: 'pr-validation.yml', jobName: JOB, currentRunId: 1};

  /**
   * A fake of the repository's API for a set of pull requests.
   *
   * @param {Array<{ number: number, sha: string, draft?: boolean, runs: Array<object>, jobs: Record<number, Array<object>> }>} pulls Pull requests with their runs and each run's jobs
   * @return {{ request: Function, posts: string[] }} The fake and the writes it received
   */
  function fakeApi(pulls) {
    const posts = [];
    const request = async (path, init = {}) => {
      if (init.method === 'POST') {
        posts.push(path);
        return null;
      }
      if (path.startsWith('/pulls?')) {
        return pulls.map(({number, sha, draft = false}) => ({number, draft, head: {sha}}));
      }
      const runsOf = path.match(/head_sha=([^&]+)/);
      if (runsOf) {
        return {workflow_runs: pulls.find((pull) => pull.sha === runsOf[1]).runs};
      }
      const jobsOf = path.match(/\/actions\/runs\/(\d+)\/jobs/);
      if (jobsOf) {
        return {jobs: pulls.flatMap((pull) => pull.jobs[jobsOf[1]] ?? [])};
      }
      throw new Error(`Unexpected call: ${path}`);
    };
    return {request, posts};
  }

  /**
   * A pull request whose one run is in the given state.
   *
   * @param {number} number Pull request number
   * @param {number} runId Id of its run
   * @param {Array<object>} jobs Jobs of the run
   * @param {string} [createdAt] When the run was created
   * @return {object} Pull request for `fakeApi`
   */
  function pull(number, runId, jobs, createdAt = '2026-11-16T13:00:00Z') {
    return {
      number,
      sha: `sha${number}`,
      runs: [{id: runId, run_number: runId, created_at: createdAt}],
      jobs: {[runId]: jobs}
    };
  }

  it('re-runs the failed jobs of the pull request that has waited longest, and only that one', async () => {
    const api = fakeApi([
      pull(11, 101, droppedJobs, '2026-11-16T13:05:00Z'),
      pull(12, 102, droppedJobs, '2026-11-16T13:01:00Z'),
      pull(13, 103, droppedJobs, '2026-11-16T13:03:00Z')
    ]);

    const result = await requeueDropped({...search, request: api.request});

    assert.equal(result.outcome, 'requeued');
    assert.equal(result.pr.number, 12);
    assert.equal(result.more, 2);
    assert.deepEqual(api.posts, ['/actions/runs/102/rerun-failed-jobs']);
  });

  it('does nothing while another pull request is already waiting for the org', async () => {
    const api = fakeApi([
      pull(11, 101, droppedJobs),
      pull(12, 102, with_(JOB, {status: 'queued', conclusion: null, steps: []}))
    ]);

    const result = await requeueDropped({...search, request: api.request});

    assert.equal(result.outcome, 'waiting');
    assert.equal(result.pr.number, 12);
    assert.deepEqual(api.posts, []);
  });

  it('does nothing when no pull request has a dropped validation', async () => {
    const api = fakeApi([
      pull(11, 101, with_(JOB, {conclusion: 'success', steps: [{}]})),
      pull(12, 102, with_(JOB, {conclusion: 'cancelled', steps: [{}]}))
    ]);

    const result = await requeueDropped({...search, request: api.request});

    assert.equal(result.outcome, 'none');
    assert.deepEqual(api.posts, []);
  });

  it('leaves out a draft pull request and this run\'s own', async () => {
    const api = fakeApi([
      {...pull(11, 101, droppedJobs), draft: true},
      pull(12, 1, droppedJobs)
    ]);

    const result = await requeueDropped({...search, request: api.request});

    assert.equal(result.outcome, 'none');
    assert.deepEqual(api.posts, []);
  });

  it('reads only the newest run of a pull request, so a validation that has since passed is not re-run', async () => {
    const api = fakeApi([{
      number: 11,
      sha: 'sha11',
      runs: [
        {id: 101, run_number: 1, created_at: '2026-11-16T13:00:00Z'},
        {id: 102, run_number: 2, created_at: '2026-11-16T13:10:00Z'}
      ],
      jobs: {
        101: droppedJobs,
        102: with_(JOB, {conclusion: 'success', steps: [{}]})
      }
    }]);

    const result = await requeueDropped({...search, request: api.request});

    assert.equal(result.outcome, 'none');
    assert.deepEqual(api.posts, []);
  });

  it('reports what it would re-run, and re-runs nothing, on a dry run', async () => {
    const api = fakeApi([pull(11, 101, droppedJobs)]);

    const result = await requeueDropped({...search, request: api.request, dryRun: true});

    assert.equal(result.outcome, 'would-requeue');
    assert.equal(result.pr.number, 11);
    assert.deepEqual(api.posts, []);
  });
});
