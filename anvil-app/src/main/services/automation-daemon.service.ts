import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationDaemonStatus } from '../../shared/types.js';

const AUTOMATION_DAEMON_LABEL = 'dev.anthonyhumphreys.anvil.automation-daemon';
const SYSTEMD_SERVICE_NAME = `${AUTOMATION_DAEMON_LABEL}.service`;

function isMac(): boolean {
  return process.platform === 'darwin';
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

function getLaunchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${AUTOMATION_DAEMON_LABEL}.plist`);
}

function getSystemdServicePath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME);
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

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function systemdUnit(): string {
  const command = getProgramArguments().map(quoteSystemdArgument).join(' ');
  return `[Unit]
Description=Anvil automation daemon
After=graphical-session.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${quoteSystemdArgument(app.getPath('userData'))}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
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

function runSystemctl(args: string[], bestEffort = false): boolean {
  try {
    execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (!bestEffort) throw error;
    return false;
  }
}

function isSystemdAvailable(): boolean {
  try {
    execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isSystemdServiceLoaded(): boolean {
  return runSystemctl(['is-active', '--quiet', SYSTEMD_SERVICE_NAME], true);
}

export function isAutomationDaemonMode(): boolean {
  return process.argv.includes('--automation-daemon');
}

export function getAutomationDaemonStatus(): AutomationDaemonStatus {
  const plistPath = getLaunchAgentPath();
  const servicePath = getSystemdServicePath();
  if (isLinux()) {
    const supported = isSystemdAvailable();
    return {
      supported,
      installed: fs.existsSync(servicePath),
      loaded: supported && isSystemdServiceLoaded(),
      mode: isAutomationDaemonMode() ? 'daemon' : 'app',
      label: SYSTEMD_SERVICE_NAME,
      servicePath,
      lastError: supported ? undefined : 'systemd user services are unavailable.',
    };
  }
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
  if (isLinux()) {
    if (!isSystemdAvailable()) return getAutomationDaemonStatus();
    const servicePath = getSystemdServicePath();
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, systemdUnit(), 'utf8');
    runSystemctl(['daemon-reload']);
    runSystemctl(['enable', '--now', SYSTEMD_SERVICE_NAME]);
    return getAutomationDaemonStatus();
  }
  if (!isMac()) return getAutomationDaemonStatus();

  const plistPath = getLaunchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plistXml(), 'utf8');
  unloadLaunchAgent(plistPath);
  loadLaunchAgent(plistPath);
  return getAutomationDaemonStatus();
}

export function uninstallAutomationDaemon(): AutomationDaemonStatus {
  if (isLinux()) {
    const servicePath = getSystemdServicePath();
    runSystemctl(['disable', '--now', SYSTEMD_SERVICE_NAME], true);
    if (fs.existsSync(servicePath)) fs.rmSync(servicePath, { force: true });
    runSystemctl(['daemon-reload'], true);
    return getAutomationDaemonStatus();
  }
  if (!isMac()) return getAutomationDaemonStatus();

  const plistPath = getLaunchAgentPath();
  if (fs.existsSync(plistPath)) {
    unloadLaunchAgent(plistPath);
    fs.rmSync(plistPath, { force: true });
  }
  return getAutomationDaemonStatus();
}
