# salesforce-validation-action

Validates the metadata a pull request changes against a real org — a check-only
deployment, which runs the Apex tests and saves nothing — and reports both the
outcome and the scope.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0          # the delta needs the history behind the merge base

- uses: malyavi/salesforce-validation-action@v1
  with:
    jwt-key: ${{ secrets.SF_JWT_KEY }}
    username: ${{ vars.SF_USERNAME }}
    client-id: ${{ vars.SF_CLIENT_ID }}
    instance-url: ${{ vars.SF_INSTANCE_URL }}
```

## What a run does

1. **Stands down if it is already out of date** — a newer commit on the pull
   request, or a pull request that was closed while this run queued.
2. **Installs the Salesforce CLI and sfdx-git-delta.**
3. **Builds the delta** between the merge base and what is checked out.
4. **Finishes green without logging in** when no metadata changed. A pull
   request that only touches tests, documentation or tooling costs seconds.
5. **Authenticates**, then **prunes the deletions** the org has already applied.
6. **Runs one check-only deployment** and reports it: the scope in the pull
   request comment, the Metadata API's own errors in the job summary, and the
   quick-deploy id as an output.

## The decisions worth knowing about

**Pruning deletions is not optional housekeeping.** sfdx-git-delta derives
`destructiveChanges.xml` from the git diff alone, so it lists everything the
branch removed whether or not the component is still in the org. Deleting a
component that is not there is a hard error — `No <Type> named: X found` — and
that happens whenever something left the org by another route: removing a custom
object takes its layouts with it, so a later commit tidying up the orphaned
layout files describes a deletion the org performed months ago. The check is one
`listMetadata` call per type and it only ever *removes* members, so a pruned run
is a subset of what was going to be attempted anyway.

It **fails open**: a type that cannot be listed keeps all of its members. A
spurious failure then behaves like no pruning, where guessing the other way
would silently skip a deletion that was genuinely required and leave the org
ahead of the source with nothing in the log to say so.

**`extra-dirs` is one request, not two.** Point it at a directory outside the
package — a samples tree, a connected-app definition deployed by hand — and when
one of them changes, every directory is converted into a single metadata-format
package with the deletions written in as `destructiveChangesPost.xml`. That
shape exists because the CLI offers no other way to put a manifest, an
out-of-scope directory and a destructive manifest in front of the org together:
`--manifest` cannot reach outside the delta, `--source-dir` refuses
`--post-destructive-changes`, and two validations cannot substitute for one
because a check-only run saves nothing for the second pass to compile against.
Validating a directory is **not** a promise to deploy it; the comment says so.

**A cancelled job cancels the deployment.** A cancelled runner just disappears,
while the org keeps validating for its full wait, holding the deployment lock
against every run behind it. The job id is read out of the CLI's output as it
appears and saved to the job's environment, so the cleanup step can cancel it
even when the process that started it is gone.

## Inputs

### The credential

Either the JWT bearer flow or an sfdx auth URL. An incomplete credential is
refused by name, before anything is installed.

| Input | Default | What it does |
| --- | --- | --- |
| `jwt-key` | — | Private key, as PEM or base64-encoded PEM. |
| `username` | — | Username to authenticate as. |
| `client-id` | — | Consumer key of the connected app. |
| `instance-url` | `https://login.salesforce.com` | `https://test.salesforce.com` for a sandbox. |
| `auth-url` | — | An sfdx auth URL instead of the three above. |
| `org-alias` | `validation-target` | Alias for the duration of the run; also names the key file, so two orgs in one job do not collide. |

### The scope

| Input | Default | What it does |
| --- | --- | --- |
| `source-dirs` | `force-app` | The package directories the delta is built from. Several get one flag each, so a repository with more than one produces a single delta whose manifest resolves a component in either. |
| `extra-dirs` | — | Directories outside the delta, validated whole when one of them changes. |
| `delta` | `true` | Off validates the whole source directory — how a repository checks an org it has never deployed to. |
| `base-sha` | merge base | Commit to diff against. Pass it to save an API call, or to give a push event a base. |
| `head-sha` | `HEAD` | Commit to diff up to. |
| `ignore-whitespace` | `true` | Whether a whitespace-only change counts. |
| `destructive-changes` | `post` | `post`, `pre` or `ignore`. |
| `prune-destructive` | `true` | Whether to drop deletions the org has already applied. |
| `test-level` | `RunLocalTests` | `NoTestRun`, `RunSpecifiedTests`, `RunLocalTests` or `RunAllTestsInOrg`. |
| `tests` | — | Classes for `RunSpecifiedTests`. |
| `wait-minutes` | `30` | How long to wait for the org. |
| `api-version` | from `sfdx-project.json` | Only used when rewriting a pruned manifest. |
| `json-report` | — | A path to write the org's own structured result to; see below. |

### The run

| Input | Default | What it does |
| --- | --- | --- |
| `install-toolchain` | `true` | Installs the CLI and sfdx-git-delta. Off for a repository that pins them. |
| `sf-cli-version`, `sgd-version` | `latest` | Versions to install. |
| `skip-if-superseded` | `true` | Stand down when a newer commit has landed, or the pull request closed. |
| `logout` | `true` | Revoke the session and delete the key when the run ends. |
| `label` | `PR Validation` | How the check names itself. |
| `environment` | — | What the org is called, for the messages. Nothing is derived from it. |
| `working-directory` | `.` | Directory holding the project. |
| `comment`, `comment-section`, `comment-tag`, `comment-section-order`, `pr-number`, `github-token` | | The shared comment; see below. |

## Outputs

| Output | What it holds |
| --- | --- |
| `outcome` | `passed`, `failed` or `skipped`. |
| `deploy-id` | The validation's job id. A passing validation is promoted with `sf project deploy quick --job-id <this>`, without re-running its tests. |
| `components`, `deletions` | The size of the delta. |
| `base-sha` | The commit it was taken against. |
| `manifest-path`, `destructive-path` | The generated manifests. |
| `json-report-path`, `component-failures`, `test-failures` | The structured result, when `json-report` asked for one. |

`components`, `deletions`, `base-sha` and the two manifest paths are published
**before** the org is touched, so a later step can upload the manifests or
report the scope even when the validation itself failed.

## A result a machine can act on

`json-report` writes the org's own answer — the component failures, the test
failures and the coverage warnings, capped and clipped — to a file:

```yaml
- uses: malyavi/salesforce-validation-action@v1
  id: validate
  continue-on-error: true
  with:
    jwt-key: ${{ secrets.SF_JWT_KEY }}
    username: ${{ vars.SF_USERNAME }}
    client-id: ${{ vars.SF_CLIENT_ID }}
    json-report: validation.json

- name: Do something with the failures
  if: always()
  run: cat validation.json
```

```json
{
  "status": "failed",
  "message": null,
  "errors": [{"component": "AccountService", "type": "ApexClass", "problem": "Variable does not exist: x", "line": 42}],
  "tests": [{"name": "AccountServiceTest", "method": "insertsTheRecord", "message": "Assertion Failed", "stackTrace": "…"}],
  "coverage": ["AccountService: Test coverage of 60% is below 75%"]
}
```

It is read with a second CLI call (`project deploy report`) rather than with
`--json` on the deployment itself, deliberately: `--json` prints nothing until
the run ends, so a two-hour validation would have an empty job log and a
cancelled job could not cancel the deployment it started. The extra call costs
one API round trip and keeps both.

## The shared comment

Give every check reporting into one comment the same `comment-tag`:

```yaml
- uses: malyavi/salesforce-validation-action@v1
  with:
    comment-tag: '<!-- ci-status -->'
    comment-section-order: validation,jest,pmd
```

## Requirements

- **`fetch-depth: 0`** on the checkout; the delta reads history.
- **`pull-requests: write`** for the comment, and `contents: read`.
- **Node 20 or newer**, which every GitHub-hosted runner has.
- A connected app with the JWT flow enabled, or an sfdx auth URL.

## Concurrency

A validation holds the org's deployment lock for as long as it runs, so serialize
the job per org and let runs queue rather than cancelling them mid-deployment:

```yaml
concurrency:
  group: validate-${{ github.base_ref }}
  cancel-in-progress: false
```

`cancel-in-progress: false` is deliberate — killing the runner would leave
Salesforce still validating with nobody watching. `skip-if-superseded` is what
handles the run that goes stale while it waits.

## Development

```bash
npm test                           # unit suite, no dependencies
python3 test/check-action-yaml.py  # action.yml parses and maps every input
test/fixtures/setup.sh /tmp/fix    # a three-branch repository to run against
```

No org is involved in the tests, and that is where the line falls rather than a
gap: everything up to the login is exercised for real in the smoke job,
including the empty-delta short circuit that has to finish green *without*
authenticating. What happens inside a check-only deployment is Salesforce's own
behaviour.
