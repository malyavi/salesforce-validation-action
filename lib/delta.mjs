import {copyFile, mkdir, rm} from 'node:fs/promises';
import {join}                from 'node:path';
import {compareCommits, fetchPullRequestFiles} from './github.mjs';
import {changedPaths, run}   from './exec.mjs';
import {ConfigError}         from './inputs.mjs';
import {readManifest, splitManifest} from './manifest.mjs';

/**
 * Turning a commit range into something the Metadata API will take.
 */

/**
 * Resolves the two ends of the range.
 *
 * The base is the *merge base* with the target branch rather than the branch
 * tip: the manifest describes what this change brings, and diffing against the
 * tip would add everything the branch has gained since. A caller that already
 * knows it — a triage job that resolved it once for several jobs — passes it in
 * and saves the API call.
 *
 * @param {{ baseSha: string, headSha: string }} config Resolved configuration
 * @return {Promise<{ baseSha: string, headSha: string, baseSource: string }>} The range and how the base was found
 * @throws {ConfigError} When there is nothing to diff against
 */
export async function resolveRange(config) {
  // HEAD rather than GITHUB_SHA: the delta has to describe what is checked
  // out, and on a pull request GITHUB_SHA is the merge commit while a caller
  // who set `ref:` on the checkout has something else again.
  const headSha = config.headSha || 'HEAD';

  if (config.baseSha) {
    return {baseSha: config.baseSha, headSha, baseSource: 'the `base-sha` input'};
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  if (!baseRef) {
    throw new ConfigError(
      'No base commit to diff against. On a pull request the target branch supplies one; ' +
      'anywhere else, pass `base-sha` — for a push, `${{ github.event.before }}` is usually right.'
    );
  }

  const comparison = await compareCommits(baseRef, headSha);
  const baseSha = comparison?.merge_base_commit?.sha;
  if (!baseSha) {
    throw new ConfigError(
      `Could not resolve the merge base between ${baseRef} and ${headSha} through the GitHub API. ` +
      'Pass `base-sha` instead, or check that the token can read the repository.'
    );
  }
  return {baseSha, headSha, baseSource: `merge base with ${baseRef}`};
}

/**
 * Builds the delta manifests with sfdx-git-delta and reads them back.
 *
 * @param {object} config Resolved configuration
 * @return {Promise<object>} The delta: the range, the manifests, and what changed outside the delta's scope
 */
export async function buildDelta(config) {
  const {baseSha, headSha, baseSource} = await resolveRange(config);
  console.log(`Diffing ${baseSha}..${headSha} (${baseSource})`);

  await mkdir(config.deltaDir, {recursive: true});
  await run('sf', [
    'sgd', 'source', 'delta',
    '--from', baseSha,
    '--to', headSha,
    // One flag per directory: a repository with several package directories
    // needs one delta covering all of them, or the manifest it writes cannot
    // resolve a component that lives in the other one.
    ...config.sourceDirs.flatMap((dir) => ['--source-dir', dir]),
    '--output-dir', config.deltaDir,
    ...(config.ignoreWhitespace ? ['--ignore-whitespace'] : [])
  ]);

  // Read from git rather than from a caller's input: a job re-run on its own
  // gets no outputs from the job that computed them, and this has to be right
  // on that path too.
  const extraFiles = config.extraDirs.length > 0
    ? await changedPaths(baseSha, headSha, config.extraDirs)
    : [];
  if (extraFiles.length > 0) {
    console.log(
      `${extraFiles.length} file(s) changed outside the delta's scope; ` +
      'validating every directory as one package.'
    );
  }

  const packageManifest = await readManifest(join(config.deltaDir, 'package/package.xml'));
  const destructiveManifest = await readManifest(
    join(config.deltaDir, 'destructiveChanges/destructiveChanges.xml')
  );

  const prNumber = process.env.INPUT_PR_NUMBER || process.env.PR_NUMBER;
  const changes = prNumber ? await fetchPullRequestFiles(prNumber) : null;
  const {added, modified} = splitManifest(packageManifest, changes || []);

  return {
    baseSha,
    headSha,
    package: packageManifest,
    added,
    modified,
    destructive: destructiveManifest,
    extraChanged: extraFiles.length > 0,
    extraFiles
  };
}

/**
 * Whether a delta has anything for the org to look at.
 *
 * @param {object} delta The delta description
 * @return {boolean} True when nothing changed that the org would see
 */
export function isEmpty(delta) {
  return delta.package.isEmpty && delta.destructive.isEmpty && !delta.extraChanged;
}

/**
 * Decides what to hand the single deployment.
 *
 * Two shapes, and which one is used turns entirely on whether a directory
 * outside the delta's scope changed:
 *
 *  - **Nothing outside it** — the delta manifest, with the deletions attached.
 *    The cheap path, and the one nearly every change takes.
 *  - **Something outside it** — every directory converted into one
 *    metadata-format package, with the delta's deletions written in as
 *    `destructiveChangesPost.xml`.
 *
 * Either way it is **one** request, and under a check-only validation that
 * matters: the CLI offers no shape that carries all three of a manifest, an
 * out-of-scope directory and a destructive manifest at once —
 *
 *  - `--manifest` reaches only what the manifest lists, and the delta is built
 *    with sfdx-git-delta's own `--source-dir`, so nothing outside it is ever in
 *    there. Widening the delta would deploy those directories too.
 *  - `--source-dir` takes every directory happily but refuses
 *    `--post-destructive-changes`: "All of the following must be provided when
 *    using --post-destructive-changes: --manifest".
 *  - Two validations cannot substitute for one, because a check-only run saves
 *    nothing for the second pass to compile against — so code in one directory
 *    that depends on a change in the other fails for a reason that will not
 *    exist after a merge.
 *
 * A metadata-format directory has none of those limits: the Metadata API reads
 * `destructiveChangesPost.xml` from the package root, so deletions travel with
 * the additions in one transaction.
 *
 * @param {object} delta The delta description
 * @param {object} config Resolved configuration
 * @return {Promise<{ args: string[], label: string }>} CLI arguments and a label for the summary
 */
export async function resolveScope(delta, config) {
  if (!config.delta) {
    const dirs = [...config.sourceDirs, ...config.extraDirs];
    return {
      args: dirs.flatMap((dir) => ['--source-dir', dir]),
      label: dirs.map((dir) => `\`${dir}/\``).join(', ') + ' in full'
    };
  }

  if (delta.extraChanged) {
    return {
      args: await buildCombinedPackage(delta.destructive, config),
      label: 'every directory as one metadata package'
    };
  }

  const args = ['--manifest', delta.package.path];
  if (!delta.destructive.isEmpty && config.destructive !== 'ignore') {
    args.push(
      config.destructive === 'pre' ? '--pre-destructive-changes' : '--post-destructive-changes',
      delta.destructive.path
    );
  }
  return {args, label: 'the delta'};
}

/**
 * Assembles every source directory, plus any deletions, into one
 * metadata-format package.
 *
 * @param {{ path: string, isEmpty: boolean }} destructive Destructive manifest to include
 * @param {object} config Resolved configuration
 * @return {Promise<string[]>} CLI arguments selecting the assembled package
 */
export async function buildCombinedPackage(destructive, config) {
  // convert merges into an existing directory, so a re-run would deploy the
  // union of this commit and the last one.
  await rm(config.mdapiDir, {recursive: true, force: true});

  await run('sf', [
    'project', 'convert', 'source',
    ...[...config.sourceDirs, ...config.extraDirs].flatMap((dir) => ['--source-dir', dir]),
    '--output-dir', config.mdapiDir
  ]);

  if (destructive && !destructive.isEmpty && config.destructive !== 'ignore') {
    const name = config.destructive === 'pre' ? 'destructiveChangesPre.xml' : 'destructiveChangesPost.xml';
    await copyFile(destructive.path, join(config.mdapiDir, name));
    console.log(`Included ${destructive.path} as ${config.mdapiDir}/${name}`);
  }

  // No --single-package: the CLI wraps the directory when zipping it, and that
  // flag asserts the opposite, failing with "No package.xml found".
  return ['--metadata-dir', config.mdapiDir];
}
