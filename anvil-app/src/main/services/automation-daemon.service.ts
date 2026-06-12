import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationDaemonStatus } from '../../shared/types.js';

const AUTOMATION_DAEMON_LABEL = 'dev.anthonyhumphreys.anvil.automation-daemon';

function isMac(): boolean {
  return process.platform === 'darwin';
}

function getLaunchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${AUTOMATION_DAEMON_LABEL}.plist`);
}

function getProgramArguments(): string[] {
  if (app.isPackaged) {
    return [process.execPath, '--automation-daemon'];
  }
  return [process.execPath, app.getAppPath(), '--automation-daemon'];
}

function plistXml(): string {
  const args = getProgramArguments()
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AUTOMATION_DAEMON_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escapeXml(app.getPath('userData'))}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(app.getPath('userData'), 'automation-daemon.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(app.getPath('userData'), 'automation-daemon.err.log'))}</string>
  </dict>
</plist>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isLaunchAgentLoaded(): boolean {
  try {
    execFileSync('launchctl', ['list', AUTOMATION_DAEMON_LABEL], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function unloadLaunchAgent(plistPath: string): void {
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

function loadLaunchAgent(plistPath: string): void {
  execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
}

export function isAutomationDaemonMode(): boolean {
  return process.argv.includes('--automation-daemon');
}

export function getAutomationDaemonStatus(): AutomationDaemonStatus {
  const plistPath = getLaunchAgentPath();
  if (!isMac()) {
    return {
      supported: false,
      installed: false,
      loaded: false,
      mode: isAutomationDaemonMode() ? 'daemon' : 'app',
    };
  }

  return {
    supported: true,
    installed: fs.existsSync(plistPath),
    loaded: isLaunchAgentLoaded(),
    mode: isAutomationDaemonMode() ? 'daemon' : 'app',
    label: AUTOMATION_DAEMON_LABEL,
    plistPath,
  };
}

export function installAutomationDaemon(): AutomationDaemonStatus {
  if (!isMac()) return getAutomationDaemonStatus();

  const plistPath = getLaunchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plistXml(), 'utf8');
  unloadLaunchAgent(plistPath);
  loadLaunchAgent(plistPath);
  return getAutomationDaemonStatus();
}

export function uninstallAutomationDaemon(): AutomationDaemonStatus {
  if (!isMac()) return getAutomationDaemonStatus();

  const plistPath = getLaunchAgentPath();
  if (fs.existsSync(plistPath)) {
    unloadLaunchAgent(plistPath);
    fs.rmSync(plistPath, { force: true });
  }
  return getAutomationDaemonStatus();
}
