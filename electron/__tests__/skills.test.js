/**
 * Tests for skills.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadSkill, listSkills, skillExists } = require('../lib/skills');

describe('skills', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadSkill', () => {
    it('loads skill content from markdown file', () => {
      const skillContent = '# Install Skill\n\nThis is the install skill.';
      fs.writeFileSync(path.join(tempDir, 'install.md'), skillContent);

      const result = loadSkill(tempDir, 'install');
      expect(result).toBe(skillContent);
    });

    it('returns null for non-existent skill', () => {
      const result = loadSkill(tempDir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('sanitizes skill name to prevent directory traversal', () => {
      const skillContent = 'Safe skill content';
      fs.writeFileSync(path.join(tempDir, 'safe.md'), skillContent);

      // Attempt directory traversal
      const result = loadSkill(tempDir, '../../../etc/passwd');
      expect(result).toBeNull();
    });

    it('allows hyphens and underscores in skill names', () => {
      const skillContent = 'Conversion setup content';
      fs.writeFileSync(path.join(tempDir, 'conversion-setup.md'), skillContent);

      const result = loadSkill(tempDir, 'conversion-setup');
      expect(result).toBe(skillContent);
    });

    it('allows underscores in skill names', () => {
      const skillContent = 'Skill with underscore';
      fs.writeFileSync(path.join(tempDir, 'my_skill.md'), skillContent);

      const result = loadSkill(tempDir, 'my_skill');
      expect(result).toBe(skillContent);
    });

    it('returns null when skills directory does not exist', () => {
      const result = loadSkill('/nonexistent/path', 'install');
      expect(result).toBeNull();
    });
  });

  describe('listSkills', () => {
    it('returns empty array for empty directory', () => {
      const result = listSkills(tempDir);
      expect(result).toEqual([]);
    });

    it('lists all markdown files without extension', () => {
      fs.writeFileSync(path.join(tempDir, 'install.md'), 'content');
      fs.writeFileSync(path.join(tempDir, 'conversion.md'), 'content');
      fs.writeFileSync(path.join(tempDir, 'setup.md'), 'content');

      const result = listSkills(tempDir);
      expect(result).toHaveLength(3);
      expect(result).toContain('install');
      expect(result).toContain('conversion');
      expect(result).toContain('setup');
    });

    it('ignores non-markdown files', () => {
      fs.writeFileSync(path.join(tempDir, 'install.md'), 'content');
      fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'content');
      fs.writeFileSync(path.join(tempDir, 'config.json'), '{}');

      const result = listSkills(tempDir);
      expect(result).toEqual(['install']);
    });

    it('returns empty array for non-existent directory', () => {
      const result = listSkills('/nonexistent/path');
      expect(result).toEqual([]);
    });
  });

  describe('skillExists', () => {
    it('returns true for existing skill', () => {
      fs.writeFileSync(path.join(tempDir, 'install.md'), 'content');

      const result = skillExists(tempDir, 'install');
      expect(result).toBe(true);
    });

    it('returns false for non-existent skill', () => {
      const result = skillExists(tempDir, 'nonexistent');
      expect(result).toBe(false);
    });

    it('sanitizes skill name for security', () => {
      fs.writeFileSync(path.join(tempDir, 'safe.md'), 'content');

      const result = skillExists(tempDir, '../../../etc/passwd');
      expect(result).toBe(false);
    });
  });
});
