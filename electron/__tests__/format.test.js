/**
 * Tests for format.js
 */

const {
  escapeHtml,
  extractCodeBlocks,
  formatInlineMarkdown,
  formatTextContent,
  formatCodeBlock,
  formatContent
} = require('../lib/format');

describe('format', () => {
  describe('escapeHtml', () => {
    it('escapes ampersand', () => {
      expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
    });

    it('escapes less than', () => {
      expect(escapeHtml('a < b')).toBe('a &lt; b');
    });

    it('escapes greater than', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('escapes double quotes', () => {
      expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('escapes single quotes', () => {
      expect(escapeHtml("it's")).toBe('it&#39;s');
    });

    it('escapes multiple special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('returns empty string for empty input', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('leaves safe text unchanged', () => {
      expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
    });
  });

  describe('extractCodeBlocks', () => {
    it('returns single text part for text without code blocks', () => {
      const result = extractCodeBlocks('Just plain text');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect(result[0].content).toBe('Just plain text');
    });

    it('extracts single code block', () => {
      const input = 'Before\n```javascript\nconst x = 1;\n```\nAfter';
      const result = extractCodeBlocks(input);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'text', content: 'Before\n' });
      expect(result[1]).toEqual({ type: 'code', language: 'javascript', content: 'const x = 1;' });
      expect(result[2]).toEqual({ type: 'text', content: '\nAfter' });
    });

    it('extracts multiple code blocks', () => {
      const input = '```js\ncode1\n```\ntext\n```python\ncode2\n```';
      const result = extractCodeBlocks(input);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'code', language: 'js', content: 'code1' });
      expect(result[1]).toEqual({ type: 'text', content: '\ntext\n' });
      expect(result[2]).toEqual({ type: 'code', language: 'python', content: 'code2' });
    });

    it('defaults to "text" language when not specified', () => {
      const input = '```\nsome code\n```';
      const result = extractCodeBlocks(input);

      expect(result[0].language).toBe('text');
    });

    it('trims code content', () => {
      const input = '```js\n\n  code  \n\n```';
      const result = extractCodeBlocks(input);

      expect(result[0].content).toBe('code');
    });
  });

  describe('formatInlineMarkdown', () => {
    it('converts inline code', () => {
      expect(formatInlineMarkdown('use `npm install`'))
        .toBe('use <code>npm install</code>');
    });

    it('converts bold text', () => {
      expect(formatInlineMarkdown('this is **important**'))
        .toBe('this is <strong>important</strong>');
    });

    it('converts italic text', () => {
      expect(formatInlineMarkdown('this is *emphasized*'))
        .toBe('this is <em>emphasized</em>');
    });

    it('escapes HTML before formatting', () => {
      expect(formatInlineMarkdown('**<script>**'))
        .toBe('<strong>&lt;script&gt;</strong>');
    });

    it('handles multiple inline formats', () => {
      expect(formatInlineMarkdown('Run `cmd` then **wait**'))
        .toBe('Run <code>cmd</code> then <strong>wait</strong>');
    });
  });

  describe('formatTextContent', () => {
    it('wraps text in paragraph', () => {
      expect(formatTextContent('Hello world'))
        .toBe('<p>Hello world</p>');
    });

    it('splits double newlines into paragraphs', () => {
      const result = formatTextContent('First paragraph\n\nSecond paragraph');

      expect(result).toContain('<p>First paragraph</p>');
      expect(result).toContain('<p>Second paragraph</p>');
    });

    it('converts single newlines to br tags', () => {
      const result = formatTextContent('Line 1\nLine 2');

      expect(result).toBe('<p>Line 1<br>Line 2</p>');
    });

    it('applies inline markdown formatting', () => {
      const result = formatTextContent('This is **bold**');

      expect(result).toBe('<p>This is <strong>bold</strong></p>');
    });

    it('filters empty paragraphs', () => {
      const result = formatTextContent('Text\n\n\n\nMore text');

      expect(result).toBe('<p>Text</p>\n<p>More text</p>');
    });
  });

  describe('formatCodeBlock', () => {
    it('wraps code in pre and code tags', () => {
      const result = formatCodeBlock('const x = 1;', 'javascript');

      expect(result).toContain('<pre>');
      expect(result).toContain('<code class="language-javascript">');
      expect(result).toContain('const x = 1;');
    });

    it('escapes HTML in code', () => {
      const result = formatCodeBlock('<div>test</div>', 'html');

      expect(result).toContain('&lt;div&gt;test&lt;/div&gt;');
    });

    it('creates runnable command block for powershell', () => {
      const result = formatCodeBlock('Get-Process', 'powershell', true);

      expect(result).toContain('class="command-block"');
      expect(result).toContain('class="run-btn"');
      expect(result).toContain('data-command="');
      expect(result).toContain('PowerShell');
    });

    it('encodes command in run button data attribute', () => {
      const result = formatCodeBlock('echo "test"', 'powershell', true);

      expect(result).toContain('data-command="echo%20%22test%22"');
    });

    it('does not add run button when runnable is false', () => {
      const result = formatCodeBlock('Get-Process', 'powershell', false);

      expect(result).not.toContain('run-btn');
    });

    it('handles case-insensitive language matching for powershell', () => {
      const result = formatCodeBlock('cmd', 'PowerShell', true);

      expect(result).toContain('class="command-block"');
    });

    it('uses "text" as default language label', () => {
      const result = formatCodeBlock('code', '');

      expect(result).toContain('language-');
    });
  });

  describe('formatContent', () => {
    it('formats plain text', () => {
      const result = formatContent('Hello world');

      expect(result).toBe('<p>Hello world</p>');
    });

    it('formats text with code blocks', () => {
      const input = 'Try this:\n```powershell\nGet-Process\n```\nDone.';
      const result = formatContent(input);

      expect(result).toContain('<p>Try this:</p>');
      expect(result).toContain('Get-Process');
      expect(result).toContain('<p>Done.</p>');
    });

    it('adds run buttons to powershell by default', () => {
      const input = '```powershell\nGet-Process\n```';
      const result = formatContent(input);

      expect(result).toContain('run-btn');
    });

    it('respects runnableCommands option', () => {
      const input = '```powershell\nGet-Process\n```';
      const result = formatContent(input, { runnableCommands: false });

      expect(result).not.toContain('run-btn');
    });

    it('does not add run buttons to non-powershell code', () => {
      const input = '```javascript\nconsole.log("hi")\n```';
      const result = formatContent(input);

      expect(result).not.toContain('run-btn');
    });

    it('handles multiple code blocks', () => {
      const input = '```js\ncode1\n```\n\n```python\ncode2\n```';
      const result = formatContent(input);

      expect(result).toContain('language-js');
      expect(result).toContain('language-python');
    });
  });
});
