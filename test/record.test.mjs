import {describe, it}                             from 'node:test';
import assert                                     from 'node:assert/strict';
import {validationRecord}                         from '../lib/record.mjs';
import {summaryPassed}                            from '../lib/report.mjs';
import {parseRecord, renderRecord, validationTag} from '../lib/validation-record.mjs';

/**
 * What a passing validation leaves behind for the deploy action, and when it
 * deliberately leaves nothing: a record of the wrong package would have the
 * deployment promote something the pull request never promised to deploy.
 */

const NOW = Date.parse('2026-09-28T12:00:00Z');

const config = {
  delta: true,
  sourceDirs: ['force-app'],
  destructive: 'post',
  ignoreWhitespace: true,
  testLevel: 'RunLocalTests',
  validationTagPrefix: 'ci/validated',
  environment: 'main'
};

const delta = {baseSha: 'b'.repeat(40), headSha: 'HEAD', extraChanged: false};

const git = {
  commit: async (ref) => (ref === 'HEAD' ? 'h'.repeat(40) : ref),
  tree: async (ref) => (ref === 'HEAD' ? 'H'.repeat(40) : 'B'.repeat(40)),
  now: NOW
};

describe('validationRecord', () => {
  it('records the job id, the range with its trees, and everything that shaped the package', async () => {
    const {record} = await validationRecord(delta, config, '0AfXX00000ABCDEFGH', git);
    assert.deepEqual(record, {
      deployId: '0AfXX00000ABCDEFGH',
      validatedAt: '2026-09-28T12:00:00.000Z',
      baseSha: 'b'.repeat(40),
      baseTree: 'B'.repeat(40),
      headSha: 'h'.repeat(40),
      headTree: 'H'.repeat(40),
      sourceDirs: ['force-app'],
      destructive: 'post',
      ignoreWhitespace: true,
      testLevel: 'RunLocalTests'
    });
    // The reader on the other side is the same module, so this is the contract.
    assert.deepEqual(parseRecord(renderRecord(record)), record);
    assert.equal(
      validationTag(config.validationTagPrefix, config.environment, record.headTree),
      `ci/validated/main/${'H'.repeat(40)}`
    );
  });

  it('records nothing for a run that folded an extra directory into the package', async () => {
    // Promoting it would deploy the extra tree, which validating it was
    // deliberately not a promise to do.
    const {record, reason} = await validationRecord({...delta, extraChanged: true}, config, '0AfXX00000ABCDEFGH', git);
    assert.equal(record, undefined);
    assert.match(reason, /outside the delta/);
  });

  it('records nothing for a validation of the whole source directory', async () => {
    const {reason} = await validationRecord(delta, {...config, delta: false}, '0AfXX00000ABCDEFGH', git);
    assert.match(reason, /whole source directory/);
  });

  it('records nothing without a job id, since there would be nothing to promote', async () => {
    assert.match((await validationRecord(delta, config, undefined, git)).reason, /no job id/);
  });

  it('records nothing it cannot pin to a tree', async () => {
    assert.match(
      (await validationRecord(delta, config, '0AfXX00000ABCDEFGH', {...git, tree: async () => null})).reason,
      /could not be read from git/
    );
  });
});

describe('summaryPassed', () => {
  const summaryConfig = {label: 'PR Validation', environment: 'staging', testLevel: 'RunLocalTests'};

  it('says where the validation was recorded, when it was', () => {
    const summary = summaryPassed(summaryConfig, {label: 'the delta'}, '0AfXX00000ABCDEFGH', 'ci/validated/main/abc');
    assert.match(summary, /Recorded as `ci\/validated\/main\/abc`/);
    assert.match(summary, /`quick-deploy` on promotes it/);
  });

  it('says nothing about a record when there is none', () => {
    assert.equal(summaryPassed(summaryConfig, {label: 'the delta'}, '0AfXX00000ABCDEFGH').includes('Recorded'), false);
  });
});
