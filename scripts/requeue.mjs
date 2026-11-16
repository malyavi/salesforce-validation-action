import {error, setOutput, summary, warn} from '../lib/core.mjs';
import {booleanInput, requireInput}      from '../lib/inputs.mjs';
import {requeueDropped, workflowFile}    from '../lib/requeue.mjs';

/**
 * Hands the org on to a pull request whose validation was dropped from the
 * concurrency group's queue, from the last step of the validating job.
 *
 * Publishes what it did as the `outcome` output: `requeued`, `would-requeue`,
 * `waiting`, `none`, `skipped` for a run that is not a pull request, or `error`.
 *
 * Never fails the job: it runs after the verdict is decided, and a validation
 * that passed or failed on its own merits must not change because this could
 * not reach the API.
 */
async function main() {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) {
    console.log('Not a pull request run, so there is no queue to hand on.');
    await setOutput('outcome', 'skipped');
    return;
  }

  const workflow = workflowFile(process.env.GITHUB_WORKFLOW_REF);
  if (!workflow) {
    warn('Could not tell which workflow file this run is from, so no dropped validation was looked for.');
    await setOutput('outcome', 'skipped');
    return;
  }

  const result = await requeueDropped({
    base,
    workflow,
    jobName: requireInput('requeue-job-name', 'Set it to the display name of the job that runs this action.'),
    currentRunId: Number(process.env.GITHUB_RUN_ID),
    dryRun: booleanInput('requeue-dry-run')
  });

  await setOutput('outcome', result.outcome);

  const waiting = result.pr ? `#${result.pr.number} (run ${result.run.id})` : '';
  switch (result.outcome) {
    case 'waiting':
      console.log(`Pull request ${waiting} is already waiting for ${base}; it will hand the org on.`);
      break;
    case 'none':
      console.log(`No pull request into ${base} has a dropped validation.`);
      break;
    default: {
      const verb = result.outcome === 'requeued' ? 'Re-running' : 'Would re-run';
      const text = `${verb} the validation of pull request ${waiting}; ${result.more} more waiting.`;
      console.log(text);
      await summary(`## Dropped validation\n\n${text}`);
    }
  }
}

try {
  await main();
} catch (thrown) {
  error(thrown.message);
  await setOutput('outcome', 'error');
}
