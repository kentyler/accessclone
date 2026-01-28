/**
 * Content formatting utilities
 * Converts markdown-like content to HTML for chat display
 *
 * This module works in both Node.js and browser environments.
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Raw text to escape
 * @returns {string} HTML-escaped text
 */
function escapeHtml(text) {
  const htmlEntities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  return text.replace(/[&<>"']/g, char => htmlEntities[char]);
}

/**
 * Extract code blocks from text
 * @param {string} text - Text containing code blocks
 * @returns {Array<{type: 'text'|'code', content: string, language?: string}>}
 */
function extractCodeBlocks(text) {
  const parts = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Add text before this code block
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex, match.index)
      });
    }

    // Add the code block
    parts.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2].trim()
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: text.slice(lastIndex)
    });
  }

  return parts;
}

/**
 * Format inline markdown (bold, code, etc.)
 * @param {string} text - Text with inline markdown
 * @returns {string} HTML formatted text
 */
function formatInlineMarkdown(text) {
  let html = escapeHtml(text);

  // Inline code (must be before other formatting)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return html;
}

/**
 * Format text content (non-code) with paragraphs
 * @param {string} text - Plain text
 * @returns {string} HTML with paragraphs
 */
function formatTextContent(text) {
  const formatted = formatInlineMarkdown(text);

  // Split into paragraphs on double newlines
  const paragraphs = formatted.split(/\n\n+/);

  return paragraphs
    .map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      // Convert single newlines to <br> within paragraphs
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .filter(p => p)
    .join('\n');
}

/**
 * Format a code block as HTML
 * @param {string} code - Code content
 * @param {string} language - Language identifier (can include file path like "file:path/to/file.js")
 * @param {boolean} runnable - Whether to add action buttons
 * @returns {string} HTML code block
 */
function formatCodeBlock(code, language, runnable = false) {
  const escapedCode = escapeHtml(code);
  const langLower = language.toLowerCase();

  // Check for file block (format: "file:path/to/file.ext")
  if (runnable && langLower.startsWith('file:')) {
    const filePath = language.slice(5); // Remove "file:" prefix
    const encodedPath = encodeURIComponent(filePath);
    const encodedContent = encodeURIComponent(code);
    const extension = filePath.split('.').pop() || 'text';

    return `<div class="command-block file-block">
      <div class="command-header">
        <span>File: ${escapeHtml(filePath)}</span>
        <button class="save-btn" data-path="${encodedPath}" data-content="${encodedContent}">Save</button>
      </div>
      <pre><code class="language-${extension}">${escapedCode}</code></pre>
    </div>`;
  }

  // PowerShell command block
  if (runnable && langLower === 'powershell') {
    const encodedCommand = encodeURIComponent(code);
    return `<div class="command-block">
      <div class="command-header">
        <span>PowerShell Command - Click Run to execute</span>
        <button class="run-btn" data-command="${encodedCommand}">Run</button>
      </div>
      <pre><code>${escapedCode}</code></pre>
    </div>`;
  }

  const langLabel = language || 'text';
  return `<pre><code class="language-${langLower}">${escapedCode}</code></pre>`;
}

/**
 * Format message content for display
 * @param {string} content - Raw message content
 * @param {object} options - Formatting options
 * @param {boolean} options.runnableCommands - Add run buttons to PowerShell blocks
 * @returns {string} HTML formatted content
 */
function formatContent(content, options = {}) {
  const { runnableCommands = true } = options;

  const parts = extractCodeBlocks(content);

  return parts
    .map(part => {
      if (part.type === 'code') {
        return formatCodeBlock(part.content, part.language, runnableCommands);
      } else {
        return formatTextContent(part.content);
      }
    })
    .join('\n');
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    extractCodeBlocks,
    formatInlineMarkdown,
    formatTextContent,
    formatCodeBlock,
    formatContent
  };
}

// Export for browser (will be available as window.Format)
if (typeof window !== 'undefined') {
  window.Format = {
    escapeHtml,
    extractCodeBlocks,
    formatInlineMarkdown,
    formatTextContent,
    formatCodeBlock,
    formatContent
  };
}
