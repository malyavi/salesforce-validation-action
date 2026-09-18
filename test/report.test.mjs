import {afterEach, describe, it}  from 'node:test';
import assert                     from 'node:assert/strict';
import {parseManifest}            from '../lib/manifest.mjs';
import {isSuperseded, runContext} from '../lib/superseded.mjs';
import {
  renderFailed,
  renderNothing,
  renderPassed,
  renderRefusal,
  summaryFailed,
  summaryNothing,
  summaryPassed
}                                 from '../lib/report.mjs';

/**
 * What a reader is told, and when the run decides not to say anything because
 * it is already out of date.
 */

const config = {
  label: 'PR Validation',
  environment: 'staging',
  testLevel: 'RunLocalTests',
  sourceDirs: ['force-app'],
  extraDirs: []
};

const delta = {
  baseSha: 'b'.repeat(40),
  package: parseManifest('<types><members>A</members><name>ApexClass</name></types>'),
  destructive: parseManifest('')
};

afterEach(() => {
  for (const key of ['INPUT_PR_NUMBER', 'PR_NUMBER', 'GITHUB_REF', 'GITHUB_EVENT_PATH', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY']) {
    delete process.env[key];
  }
});

describe('renderPassed', () => {
  it('names the environment and offers the quick deploy id', () => {
    const comment = renderPassed(config, delta, '0AfXX00000ABCDEFGH');
    assert.match(comment, /^:white_check_mark: \*\*PR Validation passed \(staging\)\*\*/);
    assert.match(comment, /Quick deploy ID: `0AfXX00000ABCDEFGH`/);
    assert.match(comment, /## Delta against `bbbbbbb`/);
  });

  it('leaves the quick deploy line out when the run reported no id', () => {
    assert.equal(renderPassed(config, delta, undefined).includes('Quick deploy'), false);
  });

  it('says nothing about an environment the caller did not name', () => {
    assert.match(renderPassed({...config, environment: ''}, delta, undefined), /\*\*PR Validation passed\*\*/);
  });
});

describe('renderFailed', () => {
  it('still reports the scope, which is what says how much was being attempted', () => {
    const comment = renderFailed(config, delta);
    assert.match(comment, /^:x: \*\*PR Validation failed \(staging\)\*\*/);
    assert.match(comment, /## Delta against/);
    assert.match(comment, /"PR Validation" job log/);
  });
});

describe('renderNothing', () => {
  it('passes with the reason, since a skipped check still has to read as green', () => {
    assert.equal(
      renderNothing(config, 'no metadata changes to validate under `force-app/`.'),
      ':white_check_mark: **PR Validation (staging)**: no metadata changes to validate under `force-app/`.'
    );
  });
});

describe('renderRefusal', () => {
  it('says what to fix when the action never got as far as the org', () => {
    assert.match(
      renderRefusal(config, 'Missing credential: `jwt-key`.'),
      /:x: \*\*PR Validation \(staging\) could not run\*\*: Missing credential/
    );
  });

  it('copes with a failure that happened before the configuration resolved', () => {
    assert.match(renderRefusal(null, 'Unknown `test-level` "x".'), /\*\*PR Validation could not run\*\*/);
  });
});

describe('summaryPassed', () => {
  it('gives the command that promotes the validation without re-running its tests', () => {
    const summary = summaryPassed(config, {label: 'the delta'}, '0AfXX00000ABCDEFGH');
    assert.match(summary, /Apex test level: `RunLocalTests`/);
    assert.match(summary, /deploy quick --job-id 0AfXX00000ABCDEFGH/);
  });

  it('omits it when there is no id to quote', () => {
    assert.equal(summaryPassed(config, {label: 'the delta'}, undefined).includes('--job-id'), false);
  });
});

describe('summaryFailed', () => {
  it('quotes the tail of the output, which is where the reason is', () => {
    const output = Array.from({length: 400}, (unused, index) => `line ${index}`).join('\n');
    const summary = summaryFailed(config, {label: 'the delta'}, output);
    assert.match(summary, /line 399/);
    assert.equal(summary.includes('line 50'), false);
  });
});

describe('summaryNothing', () => {
  it('names every directory it looked at, so a surprising skip can be checked', () => {
    const summary = summaryNothing({...config, extraDirs: ['unpackaged-setup']}, delta);
    assert.match(summary, /`force-app\/` or `unpackaged-setup\/`/);
  });
});

describe('runContext', () => {
  it('prefers the caller\'s own pull request number', async () => {
    process.env.INPUT_PR_NUMBER = '42';
    assert.equal((await runContext({headSha: ''})).prNumber, '42');
  });

  it('reads the number out of the ref of a pull request run', async () => {
    process.env.GITHUB_REF = 'refs/pull/17/merge';
    assert.equal((await runContext({headSha: ''})).prNumber, '17');
  });

  it('takes the head commit from the event payload, never from GITHUB_SHA', async () => {
    // GITHUB_SHA is the *merge* commit on a pull request, which never equals
    // the head commit the API reports — using it would make every run look
    // superseded and skip the work.
    process.env.GITHUB_SHA = 'f'.repeat(40);
    process.env.GITHUB_EVENT_PATH = 'test/fixtures/pull-request-event.json';
    const context = await runContext({headSha: ''});
    assert.equal(context.headSha, 'a'.repeat(40));
    assert.equal(context.prNumber, '7');
    delete process.env.GITHUB_SHA;
  });

  it('is undefined rather than wrong when there is no event to read', async () => {
    const context = await runContext({headSha: ''});
    assert.equal(context.prNumber, undefined);
    assert.equal(context.headSha, undefined);
  });
});

describe('isSuperseded', () => {
  it('does not skip when it cannot tell', async () => {
    // A check that cannot be made is not a reason to skip the work.
    assert.equal(await isSuperseded({prNumber: '1', headSha: 'abc'}), false);
    assert.equal(await isSuperseded({prNumber: undefined, headSha: undefined}), false);
  });
});
