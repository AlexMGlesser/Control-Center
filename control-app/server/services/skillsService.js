// skillsService.js - Manages skill files in control-app/agent/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishDebugEvent } from './eventBus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.join(__dirname, '..', '..', 'agent');

export function getAllSkills() {
  try {
    publishDebugEvent(`Skills: Fetching all skills from ${SKILLS_DIR}`);
    
    if (!fs.existsSync(SKILLS_DIR)) {
      publishDebugEvent(`Skills: Directory does not exist: ${SKILLS_DIR}`);
      return [];
    }

    const files = fs.readdirSync(SKILLS_DIR);
    publishDebugEvent(`Skills: Found ${files.length} files in directory`, {
      files: files.slice(0, 10)
    });

    const skills = files
      .filter(file => file.endsWith('.md') && file !== 'AGENT_RUNTIME_CONTEXT.txt' && file !== 'AGENT_TOOL_CONTEXT.txt')
      .map(file => {
        const filePath = path.join(SKILLS_DIR, file);
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        // Extract title from first line (assuming # Title format)
        let title = file.replace('.md', '');
        if (lines[0]?.startsWith('#')) {
          title = lines[0].replace(/^#+\s+/, '').trim();
        }

        // Extract first few lines as description
        const description = lines
          .slice(1)
          .filter(line => line.trim() && !line.startsWith('#'))
          .slice(0, 3)
          .join(' ')
          .substring(0, 200);

        const skillObj = {
          id: file.replace('.md', ''),
          name: title,
          fileName: file,
          description,
          size: stats.size,
          sizeFormatted: formatFileSize(stats.size),
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString(),
          lineCount: lines.length
        };

        publishDebugEvent(`Skills: Loaded skill "${skillObj.id}"`, {
          size: skillObj.sizeFormatted,
          lines: skillObj.lineCount
        });

        return skillObj;
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    publishDebugEvent(`Skills: Successfully loaded ${skills.length} skills`);
    return skills;
  } catch (error) {
    publishDebugEvent(`Skills: Error reading skills: ${error.message}`);
    console.error('Error reading skills:', error);
    return [];
  }
}

export function getSkillById(skillId) {
  try {
    publishDebugEvent(`Skills: Reading skill "${skillId}"`);
    
    const fileName = skillId.endsWith('.md') ? skillId : `${skillId}.md`;
    const filePath = path.join(SKILLS_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      publishDebugEvent(`Skills: Skill file not found: ${filePath}`);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    const lines = content.split('\n');

    let title = fileName.replace('.md', '');
    if (lines[0]?.startsWith('#')) {
      title = lines[0].replace(/^#+\s+/, '').trim();
    }

    publishDebugEvent(`Skills: Successfully read skill "${skillId}"`, {
      size: formatFileSize(stats.size),
      lines: lines.length
    });

    return {
      id: skillId,
      name: title,
      fileName,
      content,
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      lineCount: lines.length
    };
  } catch (error) {
    publishDebugEvent(`Skills: Error reading skill ${skillId}: ${error.message}`);
    console.error(`Error reading skill ${skillId}:`, error);
    return null;
  }
}

export function createSkill(skillName, content) {
  try {
    publishDebugEvent(`Skills: Creating new skill "${skillName}"`, {
      contentLength: content.length
    });

    if (!skillName || !content) {
      throw new Error('Skill name and content are required');
    }

    // Validate skill name (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
      throw new Error('Skill name can only contain letters, numbers, hyphens, and underscores');
    }

    const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
    const filePath = path.join(SKILLS_DIR, fileName);

    if (fs.existsSync(filePath)) {
      throw new Error(`Skill "${skillName}" already exists`);
    }

    if (!fs.existsSync(SKILLS_DIR)) {
      publishDebugEvent(`Skills: Creating directory: ${SKILLS_DIR}`);
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    publishDebugEvent(`Skills: Successfully created skill "${skillName}"`, {
      path: filePath
    });

    const stats = fs.statSync(filePath);
    const lines = content.split('\n');

    return {
      success: true,
      skill: {
        id: skillName,
        name: skillName,
        fileName,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        lineCount: lines.length
      },
      message: `Skill "${skillName}" created successfully`
    };
  } catch (error) {
    publishDebugEvent(`Skills: Error creating skill "${skillName}": ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

export function updateSkill(skillId, content) {
  try {
    publishDebugEvent(`Skills: Updating skill "${skillId}"`, {
      contentLength: content.length
    });

    const fileName = skillId.endsWith('.md') ? skillId : `${skillId}.md`;
    const filePath = path.join(SKILLS_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill "${skillId}" not found`);
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    publishDebugEvent(`Skills: Successfully updated skill "${skillId}"`);

    const stats = fs.statSync(filePath);
    const lines = content.split('\n');

    return {
      success: true,
      skill: {
        id: skillId,
        name: skillId,
        fileName,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        modified: stats.mtime.toISOString(),
        lineCount: lines.length
      },
      message: `Skill "${skillId}" updated successfully`
    };
  } catch (error) {
    publishDebugEvent(`Skills: Error updating skill "${skillId}": ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

export function deleteSkill(skillId) {
  try {
    publishDebugEvent(`Skills: Deleting skill "${skillId}"`);

    const fileName = skillId.endsWith('.md') ? skillId : `${skillId}.md`;
    const filePath = path.join(SKILLS_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill "${skillId}" not found`);
    }

    fs.unlinkSync(filePath);
    publishDebugEvent(`Skills: Successfully deleted skill "${skillId}"`);

    return {
      success: true,
      message: `Skill "${skillId}" deleted successfully`
    };
  } catch (error) {
    publishDebugEvent(`Skills: Error deleting skill "${skillId}": ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
