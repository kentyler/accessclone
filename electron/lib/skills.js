/**
 * Skills file management
 * Loads skill markdown files for LLM context
 */

const fs = require('fs');
const path = require('path');

/**
 * Load a skill file by name
 * @param {string} skillsPath - Directory containing skill files
 * @param {string} skillName - Name of skill (without .md extension)
 * @returns {string|null} Skill content or null if not found
 */
function loadSkill(skillsPath, skillName) {
  // Sanitize skill name to prevent directory traversal
  const sanitized = skillName.replace(/[^a-zA-Z0-9_-]/g, '');
  const skillPath = path.join(skillsPath, `${sanitized}.md`);

  try {
    if (fs.existsSync(skillPath)) {
      return fs.readFileSync(skillPath, 'utf8');
    }
  } catch (err) {
    console.error(`Error loading skill '${skillName}':`, err.message);
  }

  return null;
}

/**
 * List all available skills
 * @param {string} skillsPath - Directory containing skill files
 * @returns {string[]} Array of skill names (without .md extension)
 */
function listSkills(skillsPath) {
  try {
    if (fs.existsSync(skillsPath)) {
      const files = fs.readdirSync(skillsPath);
      return files
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    }
  } catch (err) {
    console.error('Error listing skills:', err.message);
  }

  return [];
}

/**
 * Check if a skill exists
 * @param {string} skillsPath - Directory containing skill files
 * @param {string} skillName - Name of skill to check
 * @returns {boolean} True if skill exists
 */
function skillExists(skillsPath, skillName) {
  const sanitized = skillName.replace(/[^a-zA-Z0-9_-]/g, '');
  const skillPath = path.join(skillsPath, `${sanitized}.md`);
  return fs.existsSync(skillPath);
}

module.exports = {
  loadSkill,
  listSkills,
  skillExists
};
