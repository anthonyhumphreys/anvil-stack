import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Load a prompt template from the prompts/ directory and substitute {{variables}}.
 * In dev mode, reads from the project root. In production, reads from app resources.
 */
export function loadPromptTemplate(
  templateName: string,
  variables: Record<string, string>,
): string {
  const promptsDir = process.env.ELECTRON_RENDERER_URL
    ? path.join(process.cwd(), 'prompts')
    : path.join(app.getAppPath(), 'prompts');

  const templatePath = path.join(promptsDir, templateName);
  let template = fs.readFileSync(templatePath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}
