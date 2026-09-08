// Executed by Anvil with the reviewed repository's installed Playwright. No package download.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [moduleRoot, configPath, output, baseURL] = process.argv.slice(2);
const require = createRequire(join(moduleRoot, 'package.json'));
let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  ({ chromium } = require('playwright'));
}
const scenario = JSON.parse(readFileSync(configPath, 'utf8'));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of scenario.viewports) {
    execSync(scenario.resetCommand, {
      cwd: process.cwd(),
      env: process.env,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      baseURL,
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(baseURL).origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const result = {
      viewport: viewport.name,
      outcome: 'passed',
      steps: [],
      image: `${results.length}.png`,
      trace: `${results.length}.zip`,
    };
    try {
      for (const step of scenario.steps) {
        try {
          const locator = step.locator ? page.locator(step.locator) : null;
          switch (step.action) {
            case 'goto': {
              const target = new URL(step.value, baseURL);
              if (target.origin !== new URL(baseURL).origin)
                throw new Error('Scenario navigation must stay on the isolated server.');
              await page.goto(target.href);
              break;
            }
            case 'click':
              await locator.click();
              break;
            case 'fill':
              await locator.fill(step.value);
              break;
            case 'press':
              await locator.press(step.value);
              break;
            case 'visible':
              await locator.waitFor({ state: 'visible' });
              break;
            case 'text': {
              await locator.waitFor({ state: 'visible' });
              const actual = (await locator.innerText()).trim();
              if (actual !== step.value)
                throw new Error(
                  `Expected ${JSON.stringify(step.value)}, received ${JSON.stringify(actual)}`,
                );
              break;
            }
            default:
              throw new Error(`Unsupported action: ${step.action}`);
          }
          result.steps.push({ action: JSON.stringify(step), outcome: 'passed' });
        } catch (error) {
          result.steps.push({
            action: JSON.stringify(step),
            outcome: 'failed',
            detail: error.message,
          });
          throw error;
        }
      }
    } catch {
      result.outcome = 'failed';
    } finally {
      await page.screenshot({ path: join(output, result.image), fullPage: true });
      await context.tracing.stop({ path: join(output, result.trace) });
      await context.close();
      results.push(result);
      writeFileSync(
        join(output, 'results.json'),
        JSON.stringify({ browser: browser.version(), results }),
      );
    }
  }
} finally {
  await browser.close();
}
if (results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
