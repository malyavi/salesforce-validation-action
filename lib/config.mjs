import {readFile}                          from 'node:fs/promises';
import {tmpdir}                             from 'node:os';
import {join}                               from 'node:path';
import {booleanInput, ConfigError, input, intInput, listInput, rawInput} from './inputs.mjs';

/**
 * The action's inputs, resolved into one object.
 *
 * Two shapes of credential are accepted because a repository has usually
 * already chosen one, and refusing the other would mean rebuilding a connected
 * app to adopt this action.
 */

/** Test levels the Metadata API accepts. `NoTestRun` is not one of them for a validation. */
export const TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

/** Where the delta manifests are written, under the working directory. */
export const DELTA_DIR = '.delta';

/**
 * Where the combined metadata-format package is assembled.
 *
 * **Not dot-prefixed, and that is load-bearing.** With a dot-prefixed output
 * directory `sf project convert source` reports success, writes `package.xml`,
 * and silently omits every component file — so a deploy of it fails on things
 * it never carried, or worse appears to succeed having sent nothing.
 */
export const MDAPI_DIR = 'mdapi-deploy';

/**
 * Resolves every input.
 *
 * @return {Promise<object>} Resolved configuration
 * @throws {ConfigError} When a credential is incomplete or an input is malformed
 */
export async function resolveConfig() {
  const cwd = input('working-directory', '.');
  const orgAlias = input('org-alias', 'validation-target');
  const testLevel = input('test-level', 'RunLocalTests');

  if (!TEST_LEVELS.includes(testLevel)) {
    throw new ConfigError(`Unknown \`test-level\` "${testLevel}"; expected one of ${TEST_LEVELS.join(', ')}.`);
  }
  const tests = listInput('tests');
  if (testLevel === 'RunSpecifiedTests' && tests.length === 0) {
    throw new ConfigError('`test-level: RunSpecifiedTests` needs the `tests` input to name the classes to run.');
  }

  const config = {
    ...resolveCredentials(orgAlias),
    cwd,
    orgAlias,
    sourceDirs: listInput('source-dirs', ['force-app']),
    extraDirs: listInput('extra-dirs'),
    delta: booleanInput('delta', true),
    ignoreWhitespace: booleanInput('ignore-whitespace', true),
    baseSha: input('base-sha'),
    headSha: input('head-sha'),
    destructive: input('destructive-changes', 'post').toLowerCase(),
    pruneDestructive: booleanInput('prune-destructive', true),
    testLevel,
    tests,
    waitMinutes: intInput('wait-minutes', 30),
    jsonReport: input('json-report'),
    apiVersion: input('api-version'),
    installToolchain: booleanInput('install-toolchain', true),
    cliVersion: input('sf-cli-version', 'latest'),
    sgdVersion: input('sgd-version', 'latest'),
    skipIfSuperseded: booleanInput('skip-if-superseded', true),
    logout: booleanInput('logout', true),
    label: input('label', 'PR Validation'),
    environment: input('environment'),
    section: input('comment-section', 'validation'),
    // Relative, and they stay relative: the script changes into the working
    // directory once, so the CLI, git and every file read agree about where
    // they are without any of them being handed a directory.
    deltaDir: DELTA_DIR,
    mdapiDir: MDAPI_DIR
  };

  if (!['post', 'pre', 'ignore'].includes(config.destructive)) {
    throw new ConfigError(
      `Unknown \`destructive-changes\` "${config.destructive}"; expected post, pre or ignore.`
    );
  }
  config.apiVersion ||= await projectApiVersion(cwd);
  return config;
}

/**
 * Resolves the credential, and refuses an incomplete one by name.
 *
 * A missing credential is the commonest way this action is first run wrong, and
 * the platform's own answer to it — an authentication failure from the CLI —
 * names neither the input that is empty nor the place to set it.
 *
 * @param {string} orgAlias Alias the org is authenticated under, which names the key file
 * @return {{ authUrl: string, jwtKey: string, username: string, instanceUrl: string, clientId: string, keyPath: string }} Resolved credential
 * @throws {ConfigError} When neither credential shape is complete
 */
export function resolveCredentials(orgAlias) {
  const authUrl = rawInput('auth-url');
  const jwtKey = rawInput('jwt-key');
  const username = input('username');
  const clientId = input('client-id');
  const keyPath = join(process.env.RUNNER_TEMP || tmpdir(), `sf-auth-${orgAlias}.key`);

  if (authUrl) {
    return {authUrl, jwtKey: '', username, instanceUrl: '', clientId: '', keyPath};
  }

  const missing = [];
  if (!jwtKey) {
    missing.push('jwt-key');
  }
  if (!username) {
    missing.push('username');
  }
  if (!clientId) {
    missing.push('client-id');
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing credential: ${missing.map((name) => `\`${name}\``).join(', ')}. ` +
      'Either pass those three for the JWT bearer flow, or pass `auth-url` alone for an sfdx auth URL.'
    );
  }

  return {
    authUrl: '',
    jwtKey,
    username,
    instanceUrl: input('instance-url', 'https://login.salesforce.com'),
    clientId,
    keyPath
  };
}

/**
 * The API version the project declares, for rewriting a manifest that carries
 * none of its own.
 *
 * @param {string} cwd Directory holding sfdx-project.json
 * @return {Promise<string>} The version, or an empty string when there is no project file or no version in it
 */
export async function projectApiVersion(cwd) {
  try {
    const project = JSON.parse(await readFile(join(cwd, 'sfdx-project.json'), 'utf8'));
    return String(project.sourceApiVersion ?? '');
  } catch {
    return '';
  }
}

/**
 * The directories a run covers, for the messages that say what was looked at.
 *
 * @param {{ sourceDirs: string[], extraDirs: string[] }} config Resolved configuration
 * @param {string} conjunction Word before the last one — `or` or `and`
 * @return {string} For example `` `force-app/`, `unpackaged-setup/` or `unpackaged-samples/` ``
 */
export function treeList(config, conjunction) {
  const trees = [...config.sourceDirs, ...config.extraDirs].map((dir) => `\`${dir}/\``);
  if (trees.length === 1) {
    return trees[0];
  }
  return `${trees.slice(0, -1).join(', ')} ${conjunction} ${trees.at(-1)}`;
}
