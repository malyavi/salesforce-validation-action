import {afterEach, describe, it}                    from 'node:test';
import assert                                        from 'node:assert/strict';
import {ConfigError}                                 from '../lib/inputs.mjs';
import {resolveConfig, resolveCredentials, treeList, TEST_LEVELS} from '../lib/config.mjs';
import {deployFailureDetail, deployIdFrom, toPem}    from '../lib/salesforce.mjs';
import {versioned}                                   from '../lib/toolchain.mjs';
import {isEmpty, resolveRange, resolveScope}         from '../lib/delta.mjs';

/**
 * Everything the action decides before it touches an org — which is where a
 * caller's mistake should be caught, since the alternative is a Salesforce
 * error message that names none of these inputs.
 */

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  delete process.env.GITHUB_BASE_REF;
});

const withJwt = () => {
  process.env.INPUT_JWT_KEY = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
  process.env.INPUT_USERNAME = 'ci@example.com';
  process.env.INPUT_CLIENT_ID = '3MVG9abc';
};

describe('resolveCredentials', () => {
  it('reads the JWT bearer flow', () => {
    withJwt();
    const credentials = resolveCredentials('target');
    assert.equal(credentials.username, 'ci@example.com');
    assert.equal(credentials.instanceUrl, 'https://login.salesforce.com');
    assert.match(credentials.keyPath, /sf-auth-target\.key$/);
  });

  it('takes an sfdx auth URL instead, and asks for nothing else', () => {
    process.env.INPUT_AUTH_URL = 'force://PlatformCLI::token@example.my.salesforce.com';
    const credentials = resolveCredentials('target');
    assert.match(credentials.authUrl, /^force:\/\//);
    assert.equal(credentials.jwtKey, '');
  });

  it('names every missing input rather than failing at the login', () => {
    process.env.INPUT_USERNAME = 'ci@example.com';
    assert.throws(() => resolveCredentials('target'), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      assert.match(thrown.message, /`jwt-key`/);
      assert.match(thrown.message, /`client-id`/);
      assert.equal(thrown.message.includes('`username`'), false);
      assert.match(thrown.message, /auth-url/, 'The other way in is offered.');
      return true;
    });
  });

  it('keeps a key file per alias, so two orgs in one job do not share one', () => {
    withJwt();
    assert.notEqual(resolveCredentials('a').keyPath, resolveCredentials('b').keyPath);
  });
});

describe('resolveConfig', () => {
  it('defaults to a delta of force-app with the org\'s local tests', async () => {
    withJwt();
    const config = await resolveConfig();
    assert.deepEqual(config.sourceDirs, ['force-app']);
    assert.deepEqual(config.extraDirs, []);
    assert.equal(config.delta, true);
    assert.equal(config.testLevel, 'RunLocalTests');
    assert.equal(config.waitMinutes, 30);
    assert.equal(config.destructive, 'post');
    assert.equal(config.pruneDestructive, true);
    assert.equal(config.section, 'validation');
  });

  it('refuses a test level the Metadata API does not have', async () => {
    withJwt();
    process.env.INPUT_TEST_LEVEL = 'RunSomeTests';
    await assert.rejects(() => resolveConfig(), (thrown) => {
      assert.match(thrown.message, /Unknown `test-level` "RunSomeTests"/);
      for (const level of TEST_LEVELS) {
        assert.match(thrown.message, new RegExp(level));
      }
      return true;
    });
  });

  it('refuses RunSpecifiedTests with no tests named', async () => {
    withJwt();
    process.env.INPUT_TEST_LEVEL = 'RunSpecifiedTests';
    await assert.rejects(() => resolveConfig(), /needs the `tests` input/);
  });

  it('refuses an unknown destructive-changes value', async () => {
    withJwt();
    process.env.INPUT_DESTRUCTIVE_CHANGES = 'after';
    await assert.rejects(() => resolveConfig(), /expected post, pre or ignore/);
  });

  it('reads the API version out of sfdx-project.json when the caller names none', async () => {
    withJwt();
    process.env.INPUT_WORKING_DIRECTORY = 'test/fixtures/project';
    assert.equal((await resolveConfig()).apiVersion, '67.0');
  });

  it('prefers an explicit api-version over the project file', async () => {
    withJwt();
    process.env.INPUT_WORKING_DIRECTORY = 'test/fixtures/project';
    process.env.INPUT_API_VERSION = '62.0';
    assert.equal((await resolveConfig()).apiVersion, '62.0');
  });

  it('is empty rather than wrong when there is no project file', async () => {
    withJwt();
    assert.equal((await resolveConfig()).apiVersion, '');
  });
});

describe('treeList', () => {
  it('reads as a sentence for one directory and for several', () => {
    assert.equal(treeList({sourceDirs: ['force-app'], extraDirs: []}, 'or'), '`force-app/`');
    assert.equal(
      treeList({sourceDirs: ['force-app'], extraDirs: ['unpackaged-setup', 'unpackaged-samples']}, 'or'),
      '`force-app/`, `unpackaged-setup/` or `unpackaged-samples/`'
    );
  });

  it('covers a repository with several package directories', () => {
    assert.equal(treeList({sourceDirs: ['force-app', 'malyavi-app'], extraDirs: []}, 'and'), '`force-app/` and `malyavi-app/`');
  });
});

describe('toPem', () => {
  it('passes a PEM through, adding the trailing newline the CLI wants', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    assert.equal(toPem(pem), `${pem}\n`);
  });

  it('decodes a base64-encoded PEM, which is how a key is often pasted into a secret', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    assert.equal(toPem(Buffer.from(pem).toString('base64')), pem);
  });

  it('refuses anything that is not a key, naming the input', () => {
    assert.throws(() => toPem('not a key at all'), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      assert.match(thrown.message, /`jwt-key`/);
      return true;
    });
  });
});

describe('deployIdFrom', () => {
  it('reads the deploy id out of the CLI output', () => {
    assert.equal(deployIdFrom('Deploy ID: 0AfXX00000ABCDEFGH\n'), '0AfXX00000ABCDEFGH');
  });

  it('takes the last one, since the CLI prints it as it starts and again as it ends', () => {
    assert.equal(
      deployIdFrom('Deploy ID: 0AfXX00000AAAAAAAA\n…\nDeploy ID: 0AfXX00000BBBBBBBB\n'),
      '0AfXX00000BBBBBBBB'
    );
  });

  it('is undefined when the output has none, rather than an empty string', () => {
    assert.equal(deployIdFrom('nothing here'), undefined);
    assert.equal(deployIdFrom(undefined), undefined);
  });
});

describe('versioned', () => {
  it('pins a version and treats latest as no pin', () => {
    assert.equal(versioned('@salesforce/cli', '2.75.6'), '@salesforce/cli@2.75.6');
    assert.equal(versioned('@salesforce/cli', 'latest'), '@salesforce/cli@latest');
    assert.equal(versioned('@salesforce/cli', ''), '@salesforce/cli@latest');
  });
});

describe('resolveRange', () => {
  it('takes an explicit base and says so', async () => {
    const range = await resolveRange({baseSha: 'abc123', headSha: ''});
    assert.equal(range.baseSha, 'abc123');
    assert.equal(range.headSha, 'HEAD');
    assert.match(range.baseSource, /`base-sha`/);
  });

  it('diffs up to HEAD rather than to GITHUB_SHA', async () => {
    // On a pull request GITHUB_SHA is the merge commit, and a caller who set
    // `ref:` on the checkout has something else again; HEAD is what is there.
    process.env.GITHUB_SHA = 'f'.repeat(40);
    const range = await resolveRange({baseSha: 'abc123', headSha: ''});
    assert.equal(range.headSha, 'HEAD');
    delete process.env.GITHUB_SHA;
  });

  it('refuses with advice when there is no base and no event to read one from', async () => {
    await assert.rejects(() => resolveRange({baseSha: '', headSha: ''}), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      assert.match(thrown.message, /pass `base-sha`/);
      assert.match(thrown.message, /github\.event\.before/);
      return true;
    });
  });
});

describe('isEmpty', () => {
  const empty = {isEmpty: true};
  const full = {isEmpty: false};

  it('is true only when nothing at all changed', () => {
    assert.equal(isEmpty({package: empty, destructive: empty, extraChanged: false}), true);
    assert.equal(isEmpty({package: full, destructive: empty, extraChanged: false}), false);
    assert.equal(isEmpty({package: empty, destructive: full, extraChanged: false}), false);
    assert.equal(isEmpty({package: empty, destructive: empty, extraChanged: true}), false);
  });
});

describe('resolveScope', () => {
  const config = {delta: true, destructive: 'post', sourceDirs: ['force-app'], extraDirs: []};
  const delta = {
    package: {path: '.delta/package/package.xml', isEmpty: false},
    destructive: {path: '.delta/destructiveChanges/destructiveChanges.xml', isEmpty: false},
    extraChanged: false
  };

  it('hands over the manifest with the deletions attached after it', async () => {
    const scope = await resolveScope(delta, config);
    assert.deepEqual(scope.args, [
      '--manifest', '.delta/package/package.xml',
      '--post-destructive-changes', '.delta/destructiveChanges/destructiveChanges.xml'
    ]);
    assert.equal(scope.label, 'the delta');
  });

  it('applies the deletions first when asked to', async () => {
    const scope = await resolveScope(delta, {...config, destructive: 'pre'});
    assert.ok(scope.args.includes('--pre-destructive-changes'));
  });

  it('leaves the deletions out entirely when asked to', async () => {
    const scope = await resolveScope(delta, {...config, destructive: 'ignore'});
    assert.deepEqual(scope.args, ['--manifest', '.delta/package/package.xml']);
  });

  it('passes the manifest alone when there is nothing to delete', async () => {
    const scope = await resolveScope({...delta, destructive: {path: 'x', isEmpty: true}}, config);
    assert.deepEqual(scope.args, ['--manifest', '.delta/package/package.xml']);
  });

  it('validates every directory in full when the delta is off', async () => {
    const scope = await resolveScope(delta, {...config, delta: false, extraDirs: ['unpackaged-setup']});
    assert.deepEqual(scope.args, ['--source-dir', 'force-app', '--source-dir', 'unpackaged-setup']);
    assert.match(scope.label, /in full/);
  });

  it('names every package directory in the full scope, not just the first', async () => {
    const scope = await resolveScope(delta, {...config, delta: false, sourceDirs: ['force-app', 'malyavi-app']});
    assert.deepEqual(scope.args, ['--source-dir', 'force-app', '--source-dir', 'malyavi-app']);
  });
});

describe('deployFailureDetail', () => {
  const failedReport = {
    status: 1,
    message: 'Deploy failed.',
    result: {
      success: false,
      details: {
        componentFailures: [
          {fullName: 'AccountService', componentType: 'ApexClass', problem: 'Variable does not exist: x', lineNumber: 42},
          {fullName: 'Account.Region__c', componentType: 'CustomField', problem: 'duplicate value found'}
        ],
        runTestResult: {
          failures: [
            {name: 'AccountServiceTest', methodName: 'insertsTheRecord', message: 'Assertion Failed', stackTrace: 'Class.AccountServiceTest'}
          ],
          codeCoverageWarnings: [{name: 'AccountService', message: 'Test coverage of 60% is below 75%'}]
        }
      }
    }
  };

  it('reads the component failures, the test failures and the coverage warnings', () => {
    const detail = deployFailureDetail(failedReport);
    assert.equal(detail.status, 'failed');
    assert.equal(detail.message, 'Deploy failed.');
    assert.deepEqual(detail.errors[0], {
      component: 'AccountService',
      type: 'ApexClass',
      problem: 'Variable does not exist: x',
      line: 42
    });
    assert.equal(detail.errors[1].line, null, 'A failure with no line number reports null rather than undefined.');
    assert.equal(detail.tests[0].method, 'insertsTheRecord');
    assert.deepEqual(detail.coverage, ['AccountService: Test coverage of 60% is below 75%']);
  });

  it('calls a run passed only when the CLI and the org both said so', () => {
    assert.equal(deployFailureDetail({status: 0, result: {success: true}}).status, 'passed');
    assert.equal(deployFailureDetail({status: 0, result: {success: false}}).status, 'failed');
    assert.equal(deployFailureDetail({status: 1, result: {success: true}}).status, 'failed');
  });

  it('says something rather than nothing when a failure carried no detail at all', () => {
    // A consumer of this file has to be able to report *something*, and "it
    // failed and here is nothing" is not actionable.
    assert.match(deployFailureDetail({status: 1, result: {success: false}}).message, /did not succeed/);
  });

  it('reads a missing report as a failure rather than throwing', () => {
    const detail = deployFailureDetail(null);
    assert.equal(detail.status, 'failed');
    assert.deepEqual(detail.errors, []);
  });

  it('caps the entries and clips a long message, since another system reads this file', () => {
    const many = Array.from({length: 40}, (unused, index) => ({
      fullName: `C${index}`,
      componentType: 'ApexClass',
      problem: 'x'.repeat(5000)
    }));
    const detail = deployFailureDetail({status: 1, result: {success: false, details: {componentFailures: many}}}, {
      maxEntries: 3,
      maxMessage: 100
    });
    assert.equal(detail.errors.length, 3);
    assert.equal(detail.errors[0].problem.length, 101, 'Clipped to the cap plus the ellipsis.');
  });

  it('leaves a coverage warning with no name readable', () => {
    const detail = deployFailureDetail({
      status: 1,
      result: {success: false, details: {runTestResult: {codeCoverageWarnings: [{message: 'Org coverage is 70%'}]}}}
    });
    assert.deepEqual(detail.coverage, ['Org coverage is 70%']);
  });
});
