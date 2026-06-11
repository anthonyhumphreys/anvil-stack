import type { PackageVersionMetadata, ProvenanceVerificationResult } from "@anvilstack/shared";

export type ProvenanceVerificationInput = {
  packageName: string;
  version: string;
  integrity?: string;
  shasum?: string;
  provenance?: PackageVersionMetadata["provenance"];
};

export type AttestationFetcher = (url: string) => Promise<unknown>;

export interface ProvenanceVerifier {
  verify(input: ProvenanceVerificationInput): Promise<ProvenanceVerificationResult>;
}

export class MetadataProvenanceVerifier implements ProvenanceVerifier {
  async verify(input: ProvenanceVerificationInput): Promise<ProvenanceVerificationResult> {
    return verifyMetadataProvenance(input);
  }
}

export class FetchingProvenanceVerifier implements ProvenanceVerifier {
  constructor(private readonly fetchAttestation: AttestationFetcher = fetchJson) {}

  async verify(input: ProvenanceVerificationInput): Promise<ProvenanceVerificationResult> {
    if (input.provenance?.present !== true || !input.provenance.attestationUrl) {
      return verifyMetadataProvenance(input);
    }

    try {
      const attestation = await this.fetchAttestation(input.provenance.attestationUrl);
      return verifyMetadataProvenance({
        ...input,
        provenance: {
          ...input.provenance,
          raw: attestation
        }
      });
    } catch (error) {
      const fallback = verifyMetadataProvenance(input);
      return {
        ...fallback,
        status: "unverified",
        summary: "Provenance metadata points to an external attestation, but the attestation could not be fetched for inspection.",
        evidence: {
          ...fallback.evidence,
          fetchError: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
}

export function verifyMetadataProvenance(input: ProvenanceVerificationInput): ProvenanceVerificationResult {
  const expectedSubjectName = `${input.packageName}@${input.version}`;
  const expectedDigest = expectedDigestFor(input);

  if (input.provenance?.present !== true) {
    return {
      status: "missing",
      verified: false,
      verifier: "metadata-provenance-2026-05-20.1",
      summary: "No provenance metadata was published for this package version.",
      expectedSubjectName,
      expectedDigest
    };
  }

  const subject = extractSubject(input.provenance.raw);
  const base = {
    verified: false,
    verifier: "metadata-provenance-2026-05-20.1",
    source: input.provenance.source,
    attestationUrl: input.provenance.attestationUrl,
    expectedSubjectName,
    expectedDigest
  } satisfies Partial<ProvenanceVerificationResult>;

  if (!subject) {
    return {
      ...base,
      status: input.provenance.attestationUrl ? "unsupported" : "unverified",
      summary: input.provenance.attestationUrl
        ? "Provenance metadata points to an external attestation, but attestation fetching and cryptographic verification are not configured."
        : "Provenance metadata is present, but no local attestation subject could be inspected.",
      evidence: { rawShape: describeRawShape(input.provenance.raw) }
    };
  }

  const subjectNameMatches = expectedSubjectNames(input).some((expected) => subject.name === expected);
  const subjectDigestMatches = digestMatches(subject.digest, expectedDigest);

  if (!subjectNameMatches || subjectDigestMatches === false) {
    return {
      ...base,
      status: "subject_mismatch",
      summary: "Provenance metadata subject does not match the analysed package identity.",
      subjectName: subject.name,
      subjectDigest: subject.digest,
      evidence: { subjectNameMatches, subjectDigestMatches }
    };
  }

  return {
    ...base,
    status: "subject_matched",
    summary: "Provenance metadata subject matches the analysed package identity. Cryptographic signature verification has not been performed.",
    subjectName: subject.name,
    subjectDigest: subject.digest,
    evidence: { subjectNameMatches, subjectDigestMatches }
  };
}

function expectedDigestFor(input: ProvenanceVerificationInput): Record<string, string> | undefined {
  if (input.integrity?.startsWith("sha512-")) return { sha512: input.integrity.slice("sha512-".length) };
  if (input.shasum) return { sha1: input.shasum };
  return undefined;
}

function expectedSubjectNames(input: ProvenanceVerificationInput): string[] {
  return [
    `${input.packageName}@${input.version}`,
    input.packageName,
    `pkg:npm/${encodePackageForPurl(input.packageName)}@${input.version}`
  ];
}

function encodePackageForPurl(packageName: string): string {
  if (!packageName.startsWith("@")) return encodeURIComponent(packageName);
  const [scope, name] = packageName.split("/");
  return `${encodeURIComponent(scope ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function extractSubject(raw: unknown): { name?: string; digest?: Record<string, string> } | undefined {
  const rawRecord = asRecord(raw);
  if (!rawRecord) return undefined;

  const candidates = [
    asRecord(rawRecord.subject),
    firstRecord(rawRecord.attestations),
    firstRecord(firstRecord(rawRecord.attestations)?.subject),
    firstSubjectFromBundle(firstRecord(rawRecord.attestations)?.bundle),
    firstSubjectFromBundle(rawRecord.bundle),
    firstRecord(rawRecord.subjects),
    firstRecord(rawRecord.statement ? asRecord(rawRecord.statement)?.subject : undefined),
    firstRecord(rawRecord.payload ? asRecord(rawRecord.payload)?.subject : undefined),
    firstSubjectFromDsse(rawRecord.dsseEnvelope)
  ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

  for (const candidate of candidates) {
    const name = typeof candidate.name === "string" ? candidate.name : undefined;
    const digest = stringRecord(candidate.digest);
    if (name || digest) return { name, digest };
  }

  return undefined;
}

function digestMatches(subjectDigest: Record<string, string> | undefined, expectedDigest: Record<string, string> | undefined): boolean | undefined {
  if (!subjectDigest || !expectedDigest) return undefined;

  for (const [algorithm, expected] of Object.entries(expectedDigest)) {
    const actual = subjectDigest[algorithm];
    if (actual && actual !== expected) return false;
    if (actual && actual === expected) return true;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value.map(asRecord).find((record): record is Record<string, unknown> => Boolean(record));
  return asRecord(value);
}

function firstSubjectFromBundle(value: unknown): Record<string, unknown> | undefined {
  const bundle = asRecord(value);
  if (!bundle) return undefined;
  return firstSubjectFromDsse(bundle.dsseEnvelope);
}

function firstSubjectFromDsse(value: unknown): Record<string, unknown> | undefined {
  const envelope = asRecord(value);
  if (!envelope || typeof envelope.payload !== "string") return undefined;
  const statement = parseJson(decodeBase64(envelope.payload));
  return firstRecord(asRecord(statement)?.subject);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function describeRawShape(raw: unknown) {
  if (!raw || typeof raw !== "object") return typeof raw;
  if (Array.isArray(raw)) return "array";
  return Object.keys(raw).sort();
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Attestation fetch failed: ${response.status} ${response.statusText}`);
  return response.json();
}
