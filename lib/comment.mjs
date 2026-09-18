import {readFile} from 'node:fs/promises';
import {warn}     from './core.mjs';

/**
 * The one status comment several jobs of a pull request share, divided into
 * marker-delimited sections that each job owns.
 *
 * Jobs run in parallel and none of them can post a whole body without erasing
 * another's report, so a write reads the current comment, replaces its own
 * section, and reposts. Read-modify-write, so two jobs finishing in the same
 * instant can lose one section until the next push: the window is milliseconds
 * wide and the alternative is cross-job locking for a status comment.
 *
 * The tag and the section order are configuration rather than constants, so
 * several actions can share one comment and agree about how it reads.
 */

/** Tag identifying the comment when the caller names none. */
export const DEFAULT_COMMENT_TAG = '<!-- pr-status-comment -->';

/**
 * How far from the bottom of the conversation the status comment may sit before
 * a rewrite moves it. Within this many comments it is still in view and is
 * patched in place, which keeps its id, its reactions and its permalink;
 * further up it is deleted and reposted so the current status is not buried
 * mid-thread.
 */
const RECENT_COMMENT_WINDOW = 5;

/**
 * Resolves the comment configuration from the action's inputs.
 *
 * @return {{ tag: string, order: string[], enabled: boolean }} Tag to find the comment by, the fixed section order, and whether commenting is on at all
 */
export function commentConfig() {
  const tag = (process.env.INPUT_COMMENT_TAG || '').trim() || DEFAULT_COMMENT_TAG;
  const order = (process.env.INPUT_COMMENT_SECTION_ORDER || '')
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
  const enabled = (process.env.INPUT_COMMENT || 'true').trim() !== 'false';
  return {tag, order, enabled};
}

/**
 * Resolves the environment a comment call needs, or null outside Actions.
 *
 * @return {Promise<{ repository: string, prNumber: string|number, headers: Record<string, string> } | null>} Context, or null when the required environment is missing
 */
async function commentContext() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  let prNumber = process.env.INPUT_PR_NUMBER || process.env.PR_NUMBER;

  if (!prNumber && process.env.GITHUB_EVENT_PATH) {
    try {
      const eventData = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      prNumber = eventData.pull_request?.number ?? eventData.number;
    } catch {
      // A missing or malformed event payload is not worth a warning: the
      // caller's own `pr-number` input is the documented way in.
    }
  }

  if (!token || !repository || !prNumber) {
    return null;
  }
  return {repository, prNumber, headers: apiHeaders()};
}

/**
 * Posts or updates the tagged status comment on the current pull request.
 *
 * A comment still among the last `RECENT_COMMENT_WINDOW` comments is PATCHed in
 * place: it is already at the bottom of the conversation, and a
 * delete-and-repost there only churns the id and drops any reactions. One
 * buried further up is deleted and posted fresh so the current status is where
 * a reader looks. If the DELETE is refused, the survivor is PATCHed instead,
 * because posting fresh would leave two tagged comments on the pull request.
 *
 * Never throws: a comment is a report on work that has already happened, and a
 * reporting failure must not turn a green run red.
 *
 * @param {string} body Markdown comment body
 * @param {string} [tag] Identifier tag embedded in the comment to find it again
 * @return {Promise<void>}
 */
export async function comment(body, tag = DEFAULT_COMMENT_TAG) {
  const context = await commentContext();
  if (!context) {
    console.log(`[pr comment]\n${body}`);
    return;
  }
  const {repository, prNumber, headers} = context;

  const commentBody = tag && !body.includes(tag) ? `${tag}\n${body}` : body;
  const commentUrl = (id) => `https://api.github.com/repos/${repository}/issues/comments/${id}`;

  try {
    const existing = await findExistingComment(repository, prNumber, headers, tag);

    if (existing) {
      let updateInPlace = existing.commentsAfter < RECENT_COMMENT_WINDOW;

      if (!updateInPlace) {
        const deleted = await fetch(commentUrl(existing.id), {method: 'DELETE', headers}).catch(() => null);
        updateInPlace = !deleted || !deleted.ok;
      }

      if (updateInPlace) {
        const patched = await fetch(commentUrl(existing.id), {
          method: 'PATCH',
          headers,
          body: JSON.stringify({body: commentBody})
        });
        if (!patched.ok) {
          warn(`Failed to update the pull request comment (${patched.status}): ${await patched.text()}`);
        }
        return;
      }
    }

    const posted = await fetch(
      `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`,
      {method: 'POST', headers, body: JSON.stringify({body: commentBody})}
    );
    if (!posted.ok) {
      warn(`Failed to post the pull request comment (${posted.status}): ${await posted.text()}`);
    }
  } catch (thrown) {
    warn(`Failed to post or update the pull request comment: ${thrown.message}`);
  }
}

/**
 * Rewrites one named section of the shared status comment, leaving the rest.
 *
 * @param {string} section Section name, which is also its marker
 * @param {string} markdown The section's new content
 * @param {{ tag?: string, order?: string[], enabled?: boolean }} [config] Comment configuration; defaults to the action's inputs
 * @return {Promise<void>}
 */
export async function updateCommentSection(section, markdown, config = commentConfig()) {
  const {tag = DEFAULT_COMMENT_TAG, order = [], enabled = true} = config;
  if (!enabled) {
    return;
  }

  let existingBody = '';
  const context = await commentContext();
  if (context) {
    const existing = await findExistingComment(context.repository, context.prNumber, context.headers, tag);
    existingBody = existing?.body ?? '';
  }

  const sections = parseSections(existingBody);
  sections.set(section, markdown.trim());
  await comment(renderSections(sections, order), tag);
}

/**
 * Renders the sections back into one comment body.
 *
 * Blank lines around every marker, not just newlines: a section that ends in a
 * raw HTML line (a report closing with `</details>`) opens a markdown HTML
 * block that runs until the next blank line, so without them the markers and
 * the next section's first line are swallowed into it and two jobs' verdicts
 * render as one line of unformatted text.
 *
 * @param {Map<string, string>} sections Section content by name
 * @param {string[]} order Fixed rendering order; anything else sorts after it
 * @return {string} The comment body
 */
export function renderSections(sections, order = []) {
  const names = [...sections.keys()].sort((left, right) => sectionRank(left, order) - sectionRank(right, order));
  return names
    .map((name) => `<!-- section:${name} -->\n\n${sections.get(name)}\n\n<!-- /section:${name} -->`)
    .join('\n\n');
}

/**
 * Extracts the marker-delimited sections of a shared comment body.
 *
 * A body written before sections existed parses to nothing and is dropped on
 * the next write, which is the intended migration: the next job to report
 * rebuilds the comment in the sectioned shape.
 *
 * Whitespace around the content is stripped rather than matched exactly:
 * GitHub hands back `\r\n` line endings, and the padding around the markers is
 * a rendering detail that every write re-adds.
 *
 * @param {string} body Existing comment body, or empty
 * @return {Map<string, string>} Section content by name, in order of appearance
 */
export function parseSections(body) {
  const sections = new Map();
  const pattern = /<!-- section:([a-z0-9-]+) -->([\s\S]*?)<!-- \/section:\1 -->/g;
  for (const match of String(body ?? '').matchAll(pattern)) {
    sections.set(match[1], match[2].trim());
  }
  return sections;
}

/**
 * Sort key for section names: the fixed order first, anything else after it in
 * the order it appeared.
 *
 * @param {string} name Section name
 * @param {string[]} order The fixed order
 * @return {number} Rank, lower renders first
 */
function sectionRank(name, order) {
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

/**
 * Searches a pull request for the comment carrying `tag`.
 *
 * Every page is read even after the match, because the caller needs to know how
 * many comments follow it. The issue-comments endpoint lists oldest first and
 * has no `direction` parameter, so the position cannot be read off one request.
 *
 * @param {string} repository Repository in owner/repo form
 * @param {string|number} prNumber Pull request number
 * @param {Record<string, string>} headers Request headers
 * @param {string} tag Tag to match
 * @return {Promise<{ id: number, body?: string, commentsAfter: number } | null>} The comment and how many follow it, or null when there is none
 */
async function findExistingComment(repository, prNumber, headers, tag) {
  if (!tag) {
    return null;
  }
  const all = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      {headers}
    );
    if (!response.ok) {
      warn(`Failed to read the pull request comments (${response.status}): ${await response.text()}`);
      return null;
    }

    const comments = await response.json();
    if (!Array.isArray(comments) || comments.length === 0) {
      break;
    }
    all.push(...comments);
    if (comments.length < 100) {
      break;
    }
    page++;
  }

  const index = all.findIndex((entry) => entry.body && entry.body.includes(tag));
  if (index === -1) {
    return null;
  }
  return {...all[index], commentsAfter: all.length - index - 1};
}

/**
 * Builds the GitHub REST request headers.
 *
 * @return {Record<string, string>} Request headers
 */
function apiHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'malyavi-actions'
  };
}
