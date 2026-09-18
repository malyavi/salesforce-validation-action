import {tail}               from './core.mjs';
import {treeList}           from './config.mjs';
import {renderDeltaSummary} from './manifest.mjs';

/**
 * What a reader is told.
 *
 * The comment is the headline plus the scope, because the scope is the thing a
 * reviewer can check against their own intent — "it validated four components
 * and one deletion" is checkable, "it passed" is not. The failure detail goes
 * to the job summary, where a hundred lines of Metadata API errors do not
 * drown the conversation.
 */

/** Lines of CLI output quoted in the summary when a run fails. */
export const FAILURE_LOG_LINES = 300;

/**
 * How a run names its target, for a heading.
 *
 * @param {object} config Resolved configuration
 * @return {string} ` (staging)`, or an empty string when no environment was named
 */
function target(config) {
  return config.environment ? ` (${config.environment})` : '';
}

/**
 * The comment section for a passing run.
 *
 * @param {object} config Resolved configuration
 * @param {object} delta The delta description
 * @param {string|undefined} deployId The validation's job id, which a quick deploy is made from
 * @return {string} Markdown
 */
export function renderPassed(config, delta, deployId) {
  return [
    `:white_check_mark: **${config.label} passed${target(config)}**`,
    ...(deployId ? [`Quick deploy ID: \`${deployId}\``] : []),
    '',
    renderDeltaSummary(delta, config)
  ].join('\n');
}

/**
 * The comment section for a failing run.
 *
 * @param {object} config Resolved configuration
 * @param {object} delta The delta description
 * @return {string} Markdown
 */
export function renderFailed(config, delta) {
  return [
    `:x: **${config.label} failed${target(config)}**`,
    '',
    renderDeltaSummary(delta, config),
    '',
    `The Metadata API's own errors are in the "${config.label}" job log and its step summary.`
  ].join('\n');
}

/**
 * The comment section for a run with nothing to validate.
 *
 * @param {object} config Resolved configuration
 * @param {string} reason Why there was nothing
 * @return {string} Markdown
 */
export function renderNothing(config, reason) {
  return `:white_check_mark: **${config.label}${target(config)}**: ${reason}`;
}

/**
 * The comment section for a refusal — a missing credential, a malformed input.
 *
 * @param {object|null} config Resolved configuration, or null when it never resolved
 * @param {string} message What is wrong
 * @return {string} Markdown
 */
export function renderRefusal(config, message) {
  const label = config?.label ?? 'PR Validation';
  return `:x: **${label}${config ? target(config) : ''} could not run**: ${message}`;
}

/**
 * The job summary for a passing run, including the command that promotes the
 * validation without re-running its tests.
 *
 * @param {object} config Resolved configuration
 * @param {{ label: string }} scope What was validated
 * @param {string|undefined} deployId The validation's job id
 * @return {string} Markdown
 */
export function summaryPassed(config, scope, deployId) {
  return [
    `## :white_check_mark: Validation passed${target(config)}`,
    '',
    `Scope: ${scope.label}.`,
    `Apex test level: \`${config.testLevel}\``,
    ...(deployId
      ? [
        '',
        'This validation can be promoted without re-running its tests:',
        '',
        '```bash',
        `sf project deploy quick --job-id ${deployId}`,
        '```'
      ]
      : [])
  ].join('\n');
}

/**
 * The job summary for a failing run: the tail of the CLI's output, which is
 * where the reason is.
 *
 * @param {object} config Resolved configuration
 * @param {{ label: string }} scope What was validated
 * @param {string} output The CLI's output
 * @return {string} Markdown
 */
export function summaryFailed(config, scope, output) {
  return [
    `## :x: Validation failed${target(config)}`,
    '',
    `Scope: ${scope.label}.`,
    '',
    '```',
    tail(output, FAILURE_LOG_LINES),
    '```'
  ].join('\n');
}

/**
 * The job summary for a run with nothing to validate.
 *
 * @param {object} config Resolved configuration
 * @param {object} delta The delta description
 * @return {string} Markdown
 */
export function summaryNothing(config, delta) {
  return [
    `## :white_check_mark: No metadata changes to validate${target(config)}`,
    '',
    `Nothing under ${treeList(config, 'or')} differs from \`${delta.baseSha}\`.`
  ].join('\n');
}
