import {afterEach, describe, it}                      from 'node:test';
import assert                                         from 'node:assert/strict';
import {commentConfig, parseSections, renderSections} from '../lib/comment.mjs';

/**
 * The shared status comment, whose whole job is to let several jobs report into
 * one place without erasing each other.
 */

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
});

describe('parseSections', () => {
  it('reads back what renderSections wrote', () => {
    const sections = new Map([['tests', ':white_check_mark: passed'], ['pmd', ':x: 2 new']]);
    assert.deepEqual(parseSections(renderSections(sections)), sections);
  });

  it('survives the CRLF line endings the API hands back', () => {
    const body = '<!-- section:tests -->\r\n\r\nall good\r\n\r\n<!-- /section:tests -->';
    assert.deepEqual([...parseSections(body)], [['tests', 'all good']]);
  });

  it('keeps a section whose content is itself markdown with blank lines', () => {
    const content = 'line one\n\n| a | b |\n| --- | --- |\n\n</details>';
    const parsed = parseSections(renderSections(new Map([['infra', content]])));
    assert.equal(parsed.get('infra'), content);
  });

  it('finds nothing in a body written before sections existed, so the next write rebuilds it', () => {
    assert.equal(parseSections('### Validation passed').size, 0);
  });

  it('ignores a marker whose closing tag names a different section', () => {
    const body = '<!-- section:tests -->\n\nx\n\n<!-- /section:pmd -->';
    assert.equal(parseSections(body).size, 0);
  });
});

describe('renderSections', () => {
  it('renders the fixed order first and anything else after it', () => {
    const sections = new Map([['pmd', 'p'], ['infra', 'i'], ['tests', 't']]);
    const body = renderSections(sections, ['tests', 'pmd']);
    const order = [...body.matchAll(/<!-- section:([a-z]+) -->/g)].map((match) => match[1]);
    assert.deepEqual(order, ['tests', 'pmd', 'infra']);
  });

  it('pads every marker with a blank line', () => {
    // Without them a section ending in raw HTML opens a markdown HTML block
    // that swallows the next marker, and two jobs' verdicts render as one line.
    const body = renderSections(new Map([['tests', 'x']]));
    assert.match(body, /<!-- section:tests -->\n\nx\n\n<!-- \/section:tests -->/);
  });

  it('replaces one section and leaves the others untouched', () => {
    const existing = renderSections(new Map([['tests', 'old'], ['pmd', 'keep']]));
    const sections = parseSections(existing);
    sections.set('tests', 'new');
    const rewritten = parseSections(renderSections(sections));
    assert.equal(rewritten.get('tests'), 'new');
    assert.equal(rewritten.get('pmd'), 'keep');
  });
});

describe('commentConfig', () => {
  it('defaults to a tag, no fixed order, and commenting on', () => {
    const config = commentConfig();
    assert.match(config.tag, /^<!--.*-->$/);
    assert.deepEqual(config.order, []);
    assert.equal(config.enabled, true);
  });

  it('takes the tag and the order from the inputs', () => {
    process.env.INPUT_COMMENT_TAG = '<!-- mine -->';
    process.env.INPUT_COMMENT_SECTION_ORDER = 'validation, tests , pmd';
    const config = commentConfig();
    assert.equal(config.tag, '<!-- mine -->');
    assert.deepEqual(config.order, ['validation', 'tests', 'pmd']);
  });

  it('is off only for an explicit false, so a blank input still comments', () => {
    process.env.INPUT_COMMENT = '';
    assert.equal(commentConfig().enabled, true);
    process.env.INPUT_COMMENT = 'false';
    assert.equal(commentConfig().enabled, false);
  });
});
