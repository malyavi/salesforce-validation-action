import {readFile}       from 'node:fs/promises';
import {summary, warn}  from './core.mjs';

/**
 * Noticing that this run is already out of date.
 *
 * A validation holds the org's deployment lock for as long as it takes, so a
 * queue of them is a queue of minutes. A run that reaches the front of that
 * queue only to validate a commit nobody is looking at any more is worse than
 * no run: it delays the one that matters.
 *
 * This only *skips*; it never cancels another run. Cancelling belongs to the
 * caller's `concurrency:` block, which can do it without an API call and
 * without guessing which of two overlapping runs is the newer.
 */

/**
 * Whether the run should stand down.
 *
 * Answers false whenever it cannot tell — no token, no pull request, an API
 * that would not answer. A check that cannot be made is not a reason to skip
 * the work.
 *
 * @param {{ prNumber: string|undefined, headSha: string|undefined }} context Which pull request, and which commit this run is for
 * @return {Promise<boolean>} True when the run should be skipped
 */
export async function isSuperseded({prNumber, headSha}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!process.env.GITHUB_TOKEN || !repository || !prNumber) {
    return false;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'malyavi-actions'
      }
    });
    if (!response.ok) {
      return false;
    }

    const pullRequest = await response.json();

    if (pullRequest.state === 'closed') {
      console.log(`Skipping: pull request #${prNumber} was closed or merged while this run waited.`);
      await summary(`:fast_forward: **Skipped**: pull request #${prNumber} was closed or merged while queued.`);
      return true;
    }

    const latest = pullRequest.head?.sha;
    if (headSha && latest && latest !== headSha) {
      console.log(`Skipping: ${headSha.slice(0, 7)} is superseded by ${latest.slice(0, 7)} on #${prNumber}.`);
      await summary(
        `:fast_forward: **Skipped**: the run for \`${headSha.slice(0, 7)}\` was superseded by ` +
        `\`${latest.slice(0, 7)}\` on pull request #${prNumber}.`
      );
      return true;
    }
  } catch (thrown) {
    warn(`Could not check whether this run was superseded: ${thrown.message}`);
  }

  return false;
}

/**
 * Which pull request, and which commit of it, this run is for.
 *
 * **Not `GITHUB_SHA`.** On a pull request that is the *merge* commit, which is
 * never the head commit the API reports — so using it would make every run
 * look superseded and skip the work entirely. The head commit comes from the
 * event payload, or from the caller's own input.
 *
 * @param {{ headSha: string }} config Resolved configuration
 * @return {Promise<{ prNumber: string|undefined, headSha: string|undefined }>} The identity to check
 */
export async function runContext(config) {
  const event = await readEvent();
  const prNumber = process.env.INPUT_PR_NUMBER ||
    process.env.PR_NUMBER ||
    pullRequestFromRef() ||
    event.pull_request?.number ||
    event.number;

  return {
    prNumber: prNumber ? String(prNumber) : undefined,
    headSha: config.headSha || event.pull_request?.head?.sha
  };
}

/**
 * The event payload, or an empty object when there is none to read.
 *
 * @return {Promise<object>} The payload
 */
async function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) {
    return {};
  }
  try {
    return JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The pull request number GitHub puts in the ref of a `pull_request` run.
 *
 * @return {string|undefined} The number, or undefined on any other event
 */
function pullRequestFromRef() {
  return (process.env.GITHUB_REF || '').match(/^refs\/pull\/(\d+)\//)?.[1];
}
