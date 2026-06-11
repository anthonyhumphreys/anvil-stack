import { describe, expect, it } from "vitest";
import { FetchingProvenanceVerifier, verifyMetadataProvenance } from "./index.js";

describe("verifyMetadataProvenance", () => {
  it("marks missing provenance as unverified", () => {
    expect(
      verifyMetadataProvenance({
        packageName: "pkg",
        version: "1.0.0",
        provenance: { present: false }
      })
    ).toMatchObject({
      status: "missing",
      verified: false,
      expectedSubjectName: "pkg@1.0.0"
    });
  });

  it("matches local attestation subjects against package identity and digest", () => {
    expect(
      verifyMetadataProvenance({
        packageName: "pkg",
        version: "1.0.0",
        integrity: "sha512-test-digest",
        provenance: {
          present: true,
          source: "dist.attestations",
          raw: {
            subject: {
              name: "pkg@1.0.0",
              digest: { sha512: "test-digest" }
            }
          }
        }
      })
    ).toMatchObject({
      status: "subject_matched",
      verified: false,
      subjectName: "pkg@1.0.0",
      subjectDigest: { sha512: "test-digest" },
      evidence: { subjectNameMatches: true, subjectDigestMatches: true }
    });
  });

  it("flags attestation subject mismatches", () => {
    expect(
      verifyMetadataProvenance({
        packageName: "pkg",
        version: "1.0.0",
        integrity: "sha512-expected",
        provenance: {
          present: true,
          source: "dist.attestations",
          raw: {
            subject: {
              name: "other@1.0.0",
              digest: { sha512: "different" }
            }
          }
        }
      })
    ).toMatchObject({
      status: "subject_mismatch",
      verified: false,
      subjectName: "other@1.0.0",
      evidence: { subjectNameMatches: false, subjectDigestMatches: false }
    });
  });

  it("keeps external attestation URLs explicit as unsupported until fetched and verified", () => {
    expect(
      verifyMetadataProvenance({
        packageName: "pkg",
        version: "1.0.0",
        provenance: {
          present: true,
          source: "dist.attestations",
          attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0",
          raw: { url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0" }
        }
      })
    ).toMatchObject({
      status: "unsupported",
      verified: false,
      attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
    });
  });

  it("fetches npm attestation bundles and matches decoded DSSE subjects", async () => {
    const verifier = new FetchingProvenanceVerifier(async () => ({
      attestations: [
        {
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(
                JSON.stringify({
                  subject: [
                    {
                      name: "pkg:npm/%40scope/pkg@1.0.0",
                      digest: { sha512: "test-digest" }
                    }
                  ]
                })
              ).toString("base64")
            }
          }
        }
      ]
    }));

    await expect(
      verifier.verify({
        packageName: "@scope/pkg",
        version: "1.0.0",
        integrity: "sha512-test-digest",
        provenance: {
          present: true,
          source: "dist.attestations",
          attestationUrl: "https://registry.example/-/npm/v1/attestations/%40scope/pkg@1.0.0",
          raw: { url: "https://registry.example/-/npm/v1/attestations/%40scope/pkg@1.0.0" }
        }
      })
    ).resolves.toMatchObject({
      status: "subject_matched",
      verified: false,
      subjectName: "pkg:npm/%40scope/pkg@1.0.0",
      subjectDigest: { sha512: "test-digest" },
      evidence: { subjectNameMatches: true, subjectDigestMatches: true }
    });
  });

  it("records external attestation fetch failures as unverified evidence", async () => {
    const verifier = new FetchingProvenanceVerifier(async () => {
      throw new Error("offline");
    });

    await expect(
      verifier.verify({
        packageName: "pkg",
        version: "1.0.0",
        provenance: {
          present: true,
          source: "dist.attestations",
          attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0",
          raw: { url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0" }
        }
      })
    ).resolves.toMatchObject({
      status: "unverified",
      verified: false,
      evidence: { fetchError: "offline" }
    });
  });
});
