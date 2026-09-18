import {writeFile}                          from 'node:fs/promises';
import {commentConfig, updateCommentSection} from '../lib/comment.mjs';
import {resolveConfig, treeList}            from '../lib/config.mjs';
import {error, group, setOutput, summary, warn} from '../lib/core.mjs';
import {buildDelta, isEmpty, resolveScope}  from '../lib/delta.mjs';
import {pruneDestructive, renderPruned}     from '../lib/destructive.mjs';
import {failureMessage}                     from '../lib/inputs.mjs';
import {renderDeltaSummary}                 from '../lib/manifest.mjs';
import {
  renderFailed,
  renderNothing,
  renderPassed,
  renderRefusal,
  summaryFailed,
  summaryNothing,
  summaryPassed
}                                           from '../lib/report.mjs';
import {
  authenticate,
  clearActiveDeployment,
  deploy,
  deployFailureDetail,
  fetchDeployReport,
  registerActiveDeployment,
  teardown
}                                           from '../lib/salesforce.mjs';
import {isSuperseded, runContext}           from '../lib/superseded.mjs';
import {installToolchain}                   from '../lib/toolchain.mjs';

/**
 * Validates the metadata a change touches against a real org: a check-only
 * deployment, which runs the Apex tests and saves nothing.
 *
 * The order of the first few steps is deliberate. The delta is built before the
 * org is touched, so a change with no metadata in it costs no login. The login
 * happens before the summary is written, because pruning the deletions needs
 * the org and the summary should describe what will actually be attempted
 * rather than what the git diff alone implied.
 */

/** Set once the comment has been written, so the failure handler does not write a second one. */
let commented = false;

/** The resolved configuration, for the signal handlers and the failure handler. */
let config = null;

/** The deployment's job id, as soon as the CLI prints it — a failed run has one too. */
let jobId = null;

let shuttingDown = false;

/**
 * Cancels the org-side deployment when the runner is taken away.
 *
 * A cancelled runner simply disappears; the org keeps validating for its full
 * wait, holding the deployment lock against every run behind it. Cancelling is
 * the difference between a cancelled pull request costing nothing and costing
 * everyone else half an hour.
 *
 * @param {string} signal The signal received
 * @return {Promise<void>}
 */
async function handleSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Cancelling the validation…`);
  await teardown({orgAlias: config?.orgAlias, keyPath: config?.keyPath});
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => handleSignal(signal));
}

/**
 * Resolves the configuration, builds the delta, validates it, reports it.
 *
 * @return {Promise<void>}
 */
async function main() {
  config = await resolveConfig();
  if (config.cwd !== '.') {
    // Once, here, rather than threaded through every call: the CLI, git and
    // every file read then agree about where they are.
    process.chdir(config.cwd);
  }

  if (config.skipIfSuperseded && await isSuperseded(await runContext(config))) {
    await publishOutcome('skipped');
    return;
  }

  if (config.installToolchain) {
    await group('Install the Salesforce CLI', () => installToolchain({...config, needsDelta: config.delta}));
  }

  const delta = config.delta
    ? await group('Build the delta manifest', () => buildDelta(config))
    : {baseSha: 'the whole source directory', package: {isEmpty: false}, destructive: {isEmpty: true}, extraChanged: false};

  // Published before the org is touched, so a later step can upload the
  // manifests or report the scope even when the validation itself fails.
  await publishDelta(delta);

  if (config.delta && isEmpty(delta)) {
    console.log(`No deployable metadata changed; nothing to validate.`);
    await summary(summaryNothing(config, delta));
    await comment(renderNothing(config, `no metadata changes to validate under ${treeList(config, 'or')}.`));
    await publishOutcome('skipped');
    return;
  }

  await group('Authenticate to the org', () => authenticate(config));

  if (config.delta && config.pruneDestructive && !delta.destructive.isEmpty) {
    const pruned = await group(
      'Check the deletions against the org',
      () => pruneDestructive(delta.destructive, config)
    );
    delta.destructive = pruned.manifest;
    await summary(renderDeltaSummary(delta, config) + renderPruned(pruned));

    if (isEmpty(delta)) {
      console.log('Every change here is a deletion the org has already applied; nothing to validate.');
      await comment(renderNothing(
        config,
        'nothing to validate — the only changes were deletions the org had already applied.'
      ));
      // Republished: pruning changed what the deletion count means.
      await publishDelta(delta);
      await publishOutcome('skipped');
      return;
    }
  } else if (config.delta) {
    await summary(renderDeltaSummary(delta, config));
  }

  await validate(delta);
}

/**
 * Runs the check-only deployment.
 *
 * @param {object} delta The delta description
 * @return {Promise<void>}
 */
async function validate(delta) {
  const scope = await group('Resolve the validation scope', () => resolveScope(delta, config));
  const args = [
    ...scope.args,
    '--test-level', config.testLevel,
    ...config.tests.flatMap((name) => ['--tests', name]),
    '--wait', String(config.waitMinutes)
  ];

  let result;
  try {
    result = await deploy(args, {
      verb: 'validate',
      orgAlias: config.orgAlias,
      // Recorded as soon as the CLI prints it, so the cleanup step can cancel
      // a validation this process never gets to see the end of — and so the
      // structured report can be asked for even when the run failed.
      onJobId: (id) => {
        jobId = id;
        registerActiveDeployment(id, config.orgAlias);
      }
    });
  } catch (thrown) {
    await clearActiveDeployment();
    await writeJsonReport(jobId);
    await summary(summaryFailed(config, scope, thrown.output ?? thrown.message));
    await comment(renderFailed(config, delta));
    await publishOutcome('failed');
    throw thrown;
  }

  await clearActiveDeployment();
  await writeJsonReport(result.deployId ?? jobId);

  await summary(summaryPassed(config, scope, result.deployId));
  await comment(renderPassed(config, delta, result.deployId));
  await publishOutcome('passed', result.deployId);
}

/**
 * Writes the org's own structured result to the file the caller asked for, and
 * publishes what it counted.
 *
 * For a caller that has to act on a failure rather than read about it: a
 * pipeline that hands the errors to whatever will fix them, a bot that
 * annotates the diff. Skipped silently when no file was asked for.
 *
 * Never fatal. The verdict is already decided by the time this runs, and a
 * report that could not be written is a line in the log rather than a red run
 * on top of a red run.
 *
 * @param {string|undefined} deployId The deployment's job id
 * @return {Promise<void>}
 */
async function writeJsonReport(deployId) {
  if (!config.jsonReport) {
    return;
  }

  const report = await fetchDeployReport(deployId, config.orgAlias);
  const detail = deployFailureDetail(report);
  try {
    await writeFile(config.jsonReport, `${JSON.stringify(detail, null, 2)}\n`, 'utf8');
    console.log(`Wrote the deployment report to ${config.jsonReport}.`);
  } catch (thrown) {
    warn(`Could not write the deployment report to ${config.jsonReport}: ${thrown.message}`);
  }

  await setOutput('json-report-path', config.jsonReport);
  await setOutput('component-failures', detail.errors.length);
  await setOutput('test-failures', detail.tests.length);
}

/**
 * Writes this action's section of the shared comment, once.
 *
 * @param {string} markdown The section's content
 * @return {Promise<void>}
 */
async function comment(markdown) {
  await updateCommentSection(config.section, markdown, commentConfig());
  commented = true;
}

/**
 * Publishes what the delta says, which is known before the org is involved.
 *
 * @param {object} delta The delta description
 * @return {Promise<void>}
 */
async function publishDelta(delta) {
  await setOutput('components', delta?.package?.componentCount ?? 0);
  await setOutput('deletions', delta?.destructive?.componentCount ?? 0);
  await setOutput('base-sha', delta?.baseSha ?? '');
  await setOutput('manifest-path', delta?.package?.path ?? '');
  await setOutput('destructive-path', delta?.destructive?.path ?? '');
}

/**
 * Publishes the verdict.
 *
 * @param {string} outcome `passed`, `failed` or `skipped`
 * @param {string} [deployId] The validation's job id, when there is one
 * @return {Promise<void>}
 */
async function publishOutcome(outcome, deployId) {
  await setOutput('outcome', outcome);
  await setOutput('deploy-id', deployId ?? '');
}

try {
  await main();
} catch (thrown) {
  error(failureMessage(thrown));
  if (!commented) {
    // A refusal the caller can act on — a missing credential, a malformed
    // input — is worth saying on the pull request; a failed validation has
    // already said everything in its own section.
    await updateCommentSection(
      config?.section ?? 'validation',
      renderRefusal(config, thrown.exitCode === undefined
        ? thrown.message
        : 'the validation could not be completed; read the job log.'),
      commentConfig()
    );
  }
  await setOutput('outcome', 'failed');
  process.exitCode = 1;
} finally {
  if (config?.logout) {
    await teardown({orgAlias: config.orgAlias, keyPath: config.keyPath});
  }
}
