import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/index.ts";

export interface Skill {
  name: string;
  description: string;
  content: string;
  keywords: string[];
}

const SKILLS_SEARCH_PATHS = [
  join(process.cwd(), "skills"),
  join(getConfigDir(), "skills"),
];

/**
 * Load and parse SKILL.md files from known directories.
 * Each H2 heading (## Name) starts a new skill section.
 */
export function loadSkills(): Skill[] {
  const skills: Skill[] = [];

  for (const dir of SKILLS_SEARCH_PATHS) {
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, "utf-8");
    const parsed = parseSkillFile(content);
    skills.push(...parsed);
    break; // Use first found
  }

  return skills;
}

function parseSkillFile(content: string): Skill[] {
  const skills: Skill[] = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const name = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    // Extract keywords from the first paragraph or explicit Keywords: line
    const keywordsMatch = body.match(/^Keywords?:\s*(.+)$/m);
    const keywords = keywordsMatch
      ? keywordsMatch[1].split(/[,;]/).map((k) => k.trim().toLowerCase())
      : extractKeywords(name + " " + body);

    // Extract description (first non-empty line after heading)
    const descMatch = body.match(/^(.+)/);
    const description = descMatch ? descMatch[1] : name;

    skills.push({ name, description, content: body, keywords });
  }

  return skills;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "and", "or", "but", "if", "then", "than", "so", "yet",
  ]);

  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !stopWords.has(w))
    .slice(0, 10);
}

/**
 * Select skills relevant to the user's input.
 * Returns at most `maxSkills` skills.
 */
export function selectRelevantSkills(
  query: string,
  skills: Skill[],
  maxSkills = 3
): Skill[] {
  const queryWords = query.toLowerCase().split(/\W+/).filter(Boolean);

  const scored = skills.map((skill) => {
    const score = skill.keywords.reduce((sum, kw) => {
      return sum + (queryWords.some((qw) => qw.includes(kw) || kw.includes(qw)) ? 1 : 0);
    }, 0);
    return { skill, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)
    .map((s) => s.skill);
}
