import {describe, it}     from 'node:test';
import assert             from 'node:assert/strict';
import {checkOnlyCommand} from '../lib/salesforce.mjs';

/**
 * Which CLI command a check-only run is sent as. `sf project deploy validate`
 * refuses `NoTestRun`, so a run without the tests has to be a dry run.
 */

describe('checkOnlyCommand', () => {
  it('validates when the tests run, at every level the CLI takes for it', () => {
    for (const level of ['RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']) {
      assert.deepEqual(checkOnlyCommand(level), {verb: 'validate', args: []});
    }
  });

  it('dry-runs a deployment when no tests run, since validate refuses NoTestRun', () => {
    assert.deepEqual(checkOnlyCommand('NoTestRun'), {verb: 'start', args: ['--dry-run']});
  });
});
