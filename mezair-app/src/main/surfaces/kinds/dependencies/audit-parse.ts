// Parses package-manager audit output (dependencies.service runDependencyAudit
// returns raw stdout) into per-package advisories.
import type {
  DependencyManager,
  DependencyVulnerability,
} from '../../../../shared/surfaces/kinds/dependencies.js';
import { normalizeSeverity } from '../findings/map.js';

export interface ParsedAuditPackage {
  name: string;
  version?: string;
  /** True/false when the tool reports it; undefined otherwise. */
  direct?: boolean;
  vulnerabilities: DependencyVulnerability[];
}

export interface ParsedAudit {
  packages: ParsedAuditPackage[];
  /** Caveat for managers whose audit is not advisory-based. */
  note?: string;
  /** Output could not be understood. */
  unparsed?: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

class Collector {
  private readonly byName = new Map<string, ParsedAuditPackage>();

  add(name: string, vulnerability: DependencyVulnerability, version?: string, direct?: boolean) {
    const entry = this.byName.get(name) ?? { name, vulnerabilities: [] };
    if (version && !entry.version) entry.version = version;
    if (direct !== undefined) entry.direct = entry.direct || direct;
    if (!entry.vulnerabilities.some((existing) => existing.id === vulnerability.id)) {
      entry.vulnerabilities.push(vulnerability);
    }
    this.byName.set(name, entry);
  }

  result(): ParsedAuditPackage[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

function vulnerability(
  id: string,
  severity: unknown,
  title: string,
  fixedIn?: string,
  url?: string,
): DependencyVulnerability {
  return {
    id: id.slice(0, 200),
    severity: normalizeSeverity(severity),
    title: (title || id).slice(0, 500),
    ...(fixedIn ? { fixedIn: fixedIn.slice(0, 200) } : {}),
    ...(url ? { url: url.slice(0, 1000) } : {}),
  };
}

function advisoryId(advisory: JsonRecord): string {
  return (
    str(advisory.github_advisory_id) ??
    (Array.isArray(advisory.cves) ? str(advisory.cves[0]) : undefined) ??
    str(advisory.id) ??
    str(advisory.source) ??
    'advisory'
  );
}

/** npm v1 / pnpm / yarn v1 advisory objects. */
function addLegacyAdvisory(collector: Collector, advisory: JsonRecord): void {
  const name = str(advisory.module_name);
  if (!name) return;
  const findings = Array.isArray(advisory.findings) ? advisory.findings.filter(isRecord) : [];
  const version = findings.map((finding) => str(finding.version)).find(Boolean);
  collector.add(
    name,
    vulnerability(
      advisoryId(advisory),
      advisory.severity,
      str(advisory.title) ?? '',
      str(advisory.patched_versions),
      str(advisory.url),
    ),
    version,
  );
}

function parseNpmV2(collector: Collector, vulnerabilities: JsonRecord): void {
  for (const [key, raw] of Object.entries(vulnerabilities)) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name) ?? key;
    const fix = raw.fixAvailable;
    const fixedIn = isRecord(fix)
      ? str(fix.name) === name
        ? str(fix.version)
        : `${str(fix.name) ?? ''}@${str(fix.version) ?? ''}`
      : undefined;
    const direct = typeof raw.isDirect === 'boolean' ? raw.isDirect : undefined;
    const via = Array.isArray(raw.via) ? raw.via : [];
    const indirect: string[] = [];
    for (const entry of via) {
      if (isRecord(entry)) {
        collector.add(
          name,
          vulnerability(
            advisoryId(entry),
            entry.severity ?? raw.severity,
            str(entry.title) ?? '',
            fixedIn,
            str(entry.url),
          ),
          undefined,
          direct,
        );
      } else if (typeof entry === 'string') {
        indirect.push(entry);
      }
    }
    if (indirect.length > 0 && !via.some(isRecord)) {
      collector.add(
        name,
        vulnerability(
          `via:${indirect.join(',')}`,
          raw.severity,
          `Depends on vulnerable ${indirect.join(', ')}`,
          fixedIn,
        ),
        undefined,
        direct,
      );
    }
  }
}

function parseJavaScriptAudit(stdout: string): ParsedAudit {
  const collector = new Collector();
  const parsed = tryJson(stdout);
  let understood = false;
  if (isRecord(parsed)) {
    if (isRecord(parsed.vulnerabilities)) {
      parseNpmV2(collector, parsed.vulnerabilities);
      understood = true;
    }
    if (isRecord(parsed.advisories)) {
      for (const advisory of Object.values(parsed.advisories)) {
        if (isRecord(advisory)) addLegacyAdvisory(collector, advisory);
      }
      understood = true;
    }
    if (isRecord(parsed.metadata) && !understood) understood = true;
  }
  if (!understood) {
    // NDJSON: yarn berry (`{value, children}`) or yarn v1 (`{type:'auditAdvisory'}`).
    for (const line of stdout.split(/\r?\n/)) {
      const record = tryJson(line);
      if (!isRecord(record)) continue;
      if (
        record.type === 'auditAdvisory' &&
        isRecord(record.data) &&
        isRecord(record.data.advisory)
      ) {
        addLegacyAdvisory(collector, record.data.advisory);
        understood = true;
      } else if (record.type === 'auditSummary') {
        understood = true;
      } else if (typeof record.value === 'string' && isRecord(record.children)) {
        const children = record.children;
        const versions = Array.isArray(children['Tree Versions']) ? children['Tree Versions'] : [];
        collector.add(
          record.value,
          vulnerability(
            str(children.ID) ?? 'advisory',
            children.Severity,
            str(children.Issue) ?? '',
            undefined,
            str(children.URL),
          ),
          str(versions[0]),
        );
        understood = true;
      }
    }
  }
  return { packages: collector.result(), ...(understood ? {} : { unparsed: true }) };
}

/** `dotnet list package --vulnerable` table output. */
function parseNugetAudit(stdout: string): ParsedAudit {
  const collector = new Collector();
  let transitive = false;
  let understood = /vulnerable packages|has no vulnerable packages/i.test(stdout);
  for (const line of stdout.split(/\r?\n/)) {
    if (/Transitive Package/i.test(line)) transitive = true;
    else if (/Top-level Package/i.test(line)) transitive = false;
    const match = /^\s*>\s+(.+)$/.exec(line);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);
    const url = tokens.find((token) => /^https?:\/\//.test(token));
    const severityIndex = tokens.findIndex((token) =>
      /^(critical|high|moderate|medium|low)$/i.test(token),
    );
    if (severityIndex < 1) continue;
    const name = tokens[0];
    const resolved = tokens[severityIndex - 1];
    const id = url ? (url.split('/').pop() ?? url) : `${name}@${resolved}`;
    collector.add(
      name,
      vulnerability(id, tokens[severityIndex], `Vulnerable ${name} ${resolved}`, undefined, url),
      resolved,
      !transitive,
    );
    understood = true;
  }
  return { packages: collector.result(), ...(understood ? {} : { unparsed: true }) };
}

export function parseAuditOutput(manager: DependencyManager, stdout: string): ParsedAudit {
  if (manager === 'python') {
    return {
      packages: [],
      note: 'pip reports outdated packages only, not security advisories.',
    };
  }
  if (manager === 'nuget') return parseNugetAudit(stdout);
  return parseJavaScriptAudit(stdout);
}
