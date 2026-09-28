import {warn}                                                         from './core.mjs';
import {run}                                                          from './exec.mjs';
import {sweepValidationRecords, validationTag, writeValidationRecord} from './validation-record.mjs';

/**
 * Leaving a record of a passing validation, so that the deploy action can
 * promote it — `sf project deploy quick` — instead of running the tests again
 * once the change lands. The record's shape, and why it is named by the tree,
 * are in `lib/validation-record.mjs`; this is the side that writes it.
 */

/**
 * The tree a commit points at, from git.
 *
 * @param {string} sha Commit sha or ref
 * @return {Promise<string|null>} The tree's sha, or null when git cannot answer
 */
export async function treeOf(sha) {
  return revParse(`${sha}^{tree}`);
}

/**
 * A ref resolved to its commit, from git — `HEAD` to the merge commit it is.
 *
 * @param {string} ref Commit sha or ref
 * @return {Promise<string|null>} The commit's sha, or null when git cannot answer
 */
export async function commitOf(ref) {
  return revParse(`${ref}^{commit}`);
}

/**
 * What a validation is a record of, or why it is not one.
 *
 * Only a validation of the delta alone is recorded. One that folded an
 * `extra-dirs` tree into a combined package, or validated the whole source
 * directory, proved something a deployment does not carry — and promoting it
 * would deploy the extra tree along with the delta, which is exactly what
 * validating it was not a promise to do.
 *
 * @param {object} delta The delta description
 * @param {object} config Resolved configuration
 * @param {string|undefined} deployId The validation's job id
 * @param {{ tree?: typeof treeOf, commit?: typeof commitOf, now?: number }} [seams] The git reads and the current time, for testing
 * @return {Promise<{ record: object }|{ reason: string }>} The record to write, or why there is none
 */
export async function validationRecord(delta, config, deployId, seams = {}) {
  const {tree = treeOf, commit = commitOf, now = Date.now()} = seams;

  if (!deployId) {
    return {reason: 'the CLI reported no job id'};
  }
  if (!config.delta) {
    return {reason: 'the whole source directory was validated, not a delta'};
  }
  if (delta.extraChanged) {
    return {
      reason: 'the validation folded a directory outside the delta into one package, which a deployment does not carry'
    };
  }

  const [baseSha, headSha] = await Promise.all([commit(delta.baseSha), commit(delta.headSha)]);
  const [baseTree, headTree] = await Promise.all([tree(delta.baseSha), tree(delta.headSha)]);
  if (!baseSha || !headSha || !baseTree || !headTree) {
    return {reason: 'the commits at the ends of the delta could not be read from git'};
  }

  return {
    record: {
      deployId,
      validatedAt: new Date(now).toISOString(),
      baseSha,
      baseTree,
      headSha,
      headTree,
      sourceDirs: config.sourceDirs,
      destructive: config.destructive,
      ignoreWhitespace: config.ignoreWhitespace,
      testLevel: config.testLevel
    }
  };
}

/**
 * Records a passing validation, and sweeps the records the org has forgotten.
 *
 * Never throws. The validation has passed; a record that could not be written
 * costs the next deployment its tests and is a warning, not a red run.
 *
 * @param {object} delta The delta description
 * @param {object} config Resolved configuration
 * @param {string|undefined} deployId The validation's job id
 * @return {Promise<string>} The tag written, or an empty string
 */
export async function recordValidation(delta, config, deployId) {
  const {record, reason} = await validationRecord(delta, config, deployId);
  if (!record) {
    console.log(`Not recording this validation for a quick deploy: ${reason}.`);
    return '';
  }

  const tag = validationTag(config.validationTagPrefix, config.environment, record.headTree);
  if (!await writeValidationRecord(tag, record)) {
    warn(
      `Could not record validation ${deployId} as ${tag}; a deployment of this change will run its tests. ` +
      'Writing the record needs `contents: write`.'
    );
    return '';
  }
  console.log(`Recorded validation ${deployId} as ${tag}, for a quick deploy of this tree.`);

  await sweepValidationRecords(config.validationTagPrefix, config.environment);
  return tag;
}

/**
 * One `git rev-parse`, quietly.
 *
 * @param {string} spec What to resolve
 * @return {Promise<string|null>} The sha, or null when git cannot answer
 */
async function revParse(spec) {
  try {
    const output = await run('git', ['rev-parse', '--verify', '--quiet', spec], {echo: false, capture: true});
    return output.trim() || null;
  } catch {
    return null;
  }
}
