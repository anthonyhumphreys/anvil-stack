import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = { identity: null, calls: [], response: () => new Response("secret body") };
globalThis.__shareFixture = fixture;
const reactUrl = import.meta.resolve("react");
const moduleUrl = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/contract/thread-pickup")) return next(new URL("../../mezair-app/cloud/contract/thread-pickup.ts", import.meta.url).href, context);
    if (context.parentURL?.includes("/mezair-app/")) {
      const desktopStubs = {
        "../db/database.js": `export const getDb = () => ({prepare: sql => ({
          all: () => sql.includes('chat_artifacts') ? globalThis.__shareFixture.desktop.artifacts : [],
          get: () => ({version: null}),
        })});`,
        "./chat-persistence.service.js": `export const getChatThread = () => globalThis.__shareFixture.desktop.thread;
          export const loadChatHistory = () => globalThis.__shareFixture.desktop.messages;`,
        "./agent-ui-intent.service.js": "export const listAgentUISurfaces = () => [];",
        "./remote-chat.service.js": `export const getRemoteChat = () => globalThis.__shareFixture.desktop.remotes[0];
          export const listRemoteChats = () => globalThis.__shareFixture.desktop.remotes;`,
        "../surfaces/index.js": "export const getMainSurfaceHandler = () => undefined;",
        "../surfaces/offscreen.js": "export const renderOffscreen = async () => {throw new Error('headless');};",
      };
      if (desktopStubs[specifier]) return next(moduleUrl(desktopStubs[specifier]), context);
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        const source = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
        if (existsSync(source)) return next(source.href, context);
      }
    }
    const stubs = {
      "@/lib/markdown": "export const renderSharedMarkdown = async text => text;",
      "next/server": "export const NextResponse = {next: () => new Response()};",
      "@/lib/auth": "export const hostedIdentity = async () => globalThis.__shareFixture.identity;",
      "@/lib/hosted/client": `export class HostedApiError extends Error {};
        export const fetchSharedArtifact = async (...args) => { globalThis.__shareFixture.calls.push(args); return globalThis.__shareFixture.response(); };`,
      "@/lib/workos-env": "export const workosConfigured = () => true;",
      "@/lib/workos-sdk": `export const authkitProxy = (options) => {globalThis.__shareFixture.proxy = options; return () => null;};
        export const getSignInUrl = async (options) => {globalThis.__shareFixture.signIn = options; return 'https://auth.example/authorize';};`,
    };
    if (stubs[specifier]) return next(moduleUrl(stubs[specifier]), context);
    // Stub presentation only; the page/route and their policy branches run unchanged.
    if (specifier.startsWith("@/components/") || ["./sandboxed-html", "./sealed-share-view", "./share-bundle-view", "./share-sign-in"].includes(specifier)) {
      return next(moduleUrl(`import {createElement as h} from '${reactUrl}';
        const View = (props) => h('div', null, props.children);
        export const SiteHeader=View, SiteFooter=View, Badge=View, Button=View, SandboxedHtml=View,
          SealedShareView=View, ShareBundleView=View, ShareSignIn=View, ShareFragmentRecovery=View;`), context);
    }
    if (specifier.startsWith("@/")) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (specifier === "./csv") return next(new URL("../app/artifacts/[id]/csv.ts", import.meta.url).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && /\.(tsx|ts)$/.test(url)) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText };
    }
    return next(url, context);
  },
});

const { fragmentKey, preserveShareFragment, restoreShareFragment, analyticsUrl } = await import("../lib/share-fragment.ts");
const { parseShareBundle, shareDownloadName, MAX_BUNDLE_CHARS } = await import("../lib/share-bundle.ts");
const { buildThreadPickupPackage, threadPickupFilename } = await import("../lib/thread-pickup.ts");
const { parseThreadPickupPackage, validateThreadContinuation, MAX_THREAD_PICKUP_TEXT_BYTES } = await import("../../mezair-app/cloud/contract/thread-pickup.ts");
const { ThreadPickupDownload } = await import("../app/artifacts/[id]/thread-pickup-download.tsx");
const { sharePath } = await import("../lib/share-access.ts");
const { GET: raw } = await import("../app/artifacts/[id]/raw/route.ts");
const { GET: signIn } = await import("../app/artifacts/[id]/sign-in/route.ts");
const { default: page, metadata } = await import("../app/artifacts/[id]/page.tsx");
await import("../proxy.ts");
const params = { params: Promise.resolve({ id: "share_123" }) };
const key = "a".repeat(43);

function browser(hash = "") {
  const items = new Map();
  const result = {
    location: { hash },
    sessionStorage: { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) },
    history: { replaceState: (_state, _title, path) => { result.path = path; result.location.hash = path.includes("#") ? path.slice(path.indexOf("#")) : ""; } },
    items,
  };
  return result;
}

test("guest share shell and all subordinate reads bypass global login redirects", () => {
  assert.ok(fixture.proxy.middlewareAuth.unauthenticatedPaths.includes("/artifacts/:path*"));
  assert.equal(metadata.robots.index, false);
});

test("page and raw use only server identity; denied responses expose no metadata or bytes", async () => {
  for (const identity of [null, { workosClientId: "client_1", workosUserId: "user_1" }]) {
    fixture.identity = identity;
    fixture.calls = [];
    fixture.response = () => new Response("secret body", { headers: { "content-type": "text/plain", "x-mezair-share-title": "Secret%20title" } });
    const html = renderToStaticMarkup(await page(params));
    assert.match(html, /Secret title/);
    const response = await raw(new Request("https://site/artifacts/share_123/raw?workosUserId=attacker"), params);
    assert.equal(await response.text(), "secret body");
    assert.deepEqual(fixture.calls, [["share_123", identity ?? undefined], ["share_123", identity ?? undefined]]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
  }
  for (const status of [401, 403]) {
    fixture.response = () => Response.json({ error: { code: status === 401 ? "unauthenticated" : "forbidden", details: { reason: "share-revoked" } }, title: "HIDDEN CONTENT" }, { status, headers: { "x-mezair-share-title": "HIDDEN CONTENT" } });
    const html = renderToStaticMarkup(await page(params));
    assert.match(html, status === 401 ? /Sign in to view/ : /Access denied/);
    assert.doesNotMatch(html, /HIDDEN CONTENT/);
    const response = await raw(new Request("https://site/artifacts/share_123/raw"), params);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-mezair-share-title"), null);
    const errorBody = await response.json();
    assert.equal(errorBody.error.code, status === 401 ? "unauthenticated" : "forbidden");
    assert.doesNotMatch(JSON.stringify(errorBody), /HIDDEN CONTENT|share-revoked/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("authorised lifecycle errors distinguish revocation and expiry", async () => {
  for (const [reason, label] of [["share-revoked", /was revoked/], ["share-expired", /has expired/]]) {
    fixture.response = () => Response.json({ error: { code: "not-found", details: { reason } } }, { status: 404 });
    assert.match(renderToStaticMarkup(await page(params)), label);
    const response = await raw(new Request("https://site/artifacts/share_123/raw"), params);
    assert.equal((await response.json()).error.code, reason);
  }
});

test("explicit sign-in sends only a validated local path to AuthKit", async () => {
  const response = await signIn(new Request(`https://site/artifacts/share_123/sign-in?returnTo=https://evil/#k=${key}`), params);
  assert.deepEqual(fixture.signIn, { returnTo: "/artifacts/share_123" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(sharePath(`share_123#k=${key}`), null);
  assert.equal(sharePath("//evil"), null);
});

test("fragment survives same-tab sign-in once, with expiry and id binding", () => {
  const b = browser(`#k=${key}`);
  preserveShareFragment("share_123", b, 1000);
  assert.equal(b.path, "/artifacts/share_123");
  assert.equal(b.items.size, 1);
  restoreShareFragment("different", b, 2000);
  assert.equal(b.location.hash, "");
  restoreShareFragment("share_123", b, 2000);
  assert.equal(b.location.hash, `#k=${key}`);
  assert.equal(b.items.size, 0);
  b.location.hash = "";
  restoreShareFragment("share_123", b, 2000);
  assert.equal(b.location.hash, "");
  b.location.hash = `#k=${key}`;
  preserveShareFragment("share_123", b, 1000);
  restoreShareFragment("share_123", b, 601001);
  assert.equal(b.location.hash, "");
});

test("malformed or duplicate keys cannot start sign-in; storage errors keep full link", () => {
  assert.equal(fragmentKey("#k=invalid"), null);
  assert.equal(fragmentKey(`#k=${key}&k=${key}`), null);
  const b = browser("#k=invalid");
  assert.throws(() => preserveShareFragment("share_123", b), /damaged/);
  assert.equal(b.location.hash, "#k=invalid");
  b.location.hash = `#k=${key}`;
  b.sessionStorage.setItem = () => { throw new Error("storage blocked"); };
  assert.throws(() => preserveShareFragment("share_123", b));
  assert.equal(b.location.hash, `#k=${key}`);
});

test("analytics drops share routes and removes any fragment elsewhere", () => {
  assert.equal(analyticsUrl(`https://site/artifacts/share_123#k=${key}`), null);
  assert.equal(analyticsUrl(`https://site/artifacts/share_123/sign-in?key=${key}`), null);
  assert.equal(analyticsUrl(`https://site/docs#k=${key}`), "https://site/docs");
});

const bundle = { format: "mezair-share/v1", title: "Thread", kind: "thread", version: 1, sharedAt: "2026-10-25T10:00:00Z", digest: "Snapshot", snapshot: { html: "<h1>Review</h1>", css: "", height: 400 }, files: [{ name: "report.pdf", mediaType: "application/pdf", dataBase64: "aGVsbG8=" }] };
test("bounded parser accepts thread snapshots and explicit binary downloads", () => {
  assert.equal(parseShareBundle(JSON.stringify(bundle))?.files[0].name, "report.pdf");
  const maxFiles = { ...bundle, files: [{ name: "big.bin", mediaType: "application/octet-stream", dataBase64: Buffer.alloc(8 * 1024 * 1024).toString("base64") }] };
  assert.ok(parseShareBundle(JSON.stringify(maxFiles)));
  maxFiles.files.push(bundle.files[0]);
  assert.equal(parseShareBundle(JSON.stringify(maxFiles)), null);
  assert.equal(shareDownloadName("../../report\u0000.pdf"), "__.._report_.pdf");
});

test("untrusted bundle fields fail closed before renderer or Blob creation", () => {
  for (const override of [
    { digest: { payload: "bad" } }, { title: [] }, { version: -1 }, { sharedAt: "invalid" },
    { snapshot: { html: "", css: "", height: "500" } },
    { snapshot: { html: "", css: "", images: { test: "https://tracker" } } },
    { interactive: { html: "<script>bad()</script>" } },
    { files: [{ ...bundle.files[0], dataBase64: "not base64" }] },
  ]) assert.equal(parseShareBundle(JSON.stringify({ ...bundle, ...override })), null);
  assert.equal(parseShareBundle(" ".repeat(MAX_BUNDLE_CHARS + 1)), null);
});


test("actual Desktop thread bundle and redactions remain compatible with the website parser", async () => {
  fixture.desktop = {
    thread: { id: "thread-1", title: "Shared thread", workspaceId: "workspace-1", repoIds: [], updatedAt: "2026-10-25T10:00:00Z" },
    messages: [
      { id: "user-1", role: "user", content: 'PASSWORD="abcd1234&efgh5678"', timestamp: "2026-10-25T10:00:00Z", sessionId: "PRIVATE_SESSION" },
      { id: "assistant-1", role: "assistant", content: "Final response", timestamp: "2026-10-25T10:01:00Z", event: { type: "text", text: "Final response" } },
      { id: "progress-1", role: "system", content: "Visible assistant progress", timestamp: "2026-10-25T10:00:30Z", event: { type: "text", text: "Visible assistant progress", assistantPhase: "progress" } },
      { id: "system-1", role: "system", content: "PRIVATE_SYSTEM_PROMPT", timestamp: "2026-10-25T10:00:00Z" },
    ],
    artifacts: [
      { id: "selected-file", title: "report.pdf", kind: "pdf", content: "selected bytes", filePath: null, version: 1 },
      { id: "excluded-file", title: "Private notes", kind: "text", content: "PRIVATE_UNSELECTED", filePath: null, version: 1 },
    ],
    remotes: [{ id: "mesh-1", sourceThreadId: "thread-1", workspaceId: "workspace-1", updatedAt: "2026-10-25T10:02:00Z", turns: [
      { prompt: "Mesh prompt", response: "Truncated Mesh answer", responseTruncated: true, createdAt: "2026-10-25T10:02:00Z", state: "completed", jobId: "PRIVATE_JOB" },
    ] }],
  };
  const { buildThreadShare } = await import("../../mezair-app/src/main/services/thread-share.service.ts");
  const { scanForSecrets, redactSecrets } = await import("../../mezair-app/src/main/services/share-secret-scan.ts");
  const built = await buildThreadShare({ itemType: "thread", itemId: "thread-1" }, { contextItemIds: ["artifact:selected-file"] });
  const findings = scanForSecrets(built.text);
  assert.ok(findings.length > 0);
  const redacted = redactSecrets(built.text, findings.map((finding) => finding.id));
  const accepted = parseShareBundle(redacted);
  assert.ok(accepted);
  assert.equal(accepted.kind, "thread");
  assert.equal(accepted.interactive, undefined);
  assert.match(accepted.snapshot.html, /Final response/);
  assert.match(accepted.snapshot.html, /Visible assistant progress/);
  assert.match(accepted.snapshot.html, /Mesh prompt/);
  assert.match(accepted.snapshot.html, /host truncated/);
  assert.match(accepted.snapshot.html, /PASSWORD=&quot;\[redacted\]&quot;/);
  assert.doesNotMatch(redacted, /PRIVATE_|abcd1234|efgh5678/);
  assert.equal(Buffer.from(accepted.files[0].dataBase64, "base64").toString(), "selected bytes");
  assert.ok(accepted.continuation);
  const pickupPackage = parseThreadPickupPackage(JSON.stringify(buildThreadPickupPackage(accepted, "share_123", "https://viewer.example")));
  assert.equal(pickupPackage.continuation.entries.length, 5);
  assert.equal(pickupPackage.continuation.entries[0].text, 'PASSWORD="[redacted]"');
  assert.equal(pickupPackage.continuation.items[0].fileIndex, 0);
});


const continuation = {
  format: "mezair-thread-continuation/v1",
  entries: [{ role: "user", text: "Continue the reviewed work", at: "2026-10-25T10:00:00Z", source: "Conversation" }],
  context: { repoNames: ["project"], ticket: { id: "APP-1", provider: "linear", title: "Work item" }, plan: "Review the changes", goal: "Finish the work" },
  items: [{ kind: "attachment", title: "Report", fileIndex: 0 }],
};
function pickup() {
  return buildThreadPickupPackage({ ...bundle, continuation }, "share_123", "https://viewer.example");
}

test("pickup exports only validated redacted content and a source reference without the browser key", () => {
  const secretKey = "z".repeat(43);
  const result = buildThreadPickupPackage({ ...bundle, continuation, privateRuntime: "PRIVATE", payload: { ignored: true } }, "share_123", `https://viewer.example/artifacts/share_123?ignored=1#k=${secretKey}`);
  assert.equal(result.source.viewerUrl, "https://viewer.example/artifacts/share_123");
  assert.equal(result.continuation.entries[0].text, "Continue the reviewed work");
  assert.deepEqual(result.files, bundle.files);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE|privateRuntime|payload|ignored|#k=|zzzzzzzz/);
  assert.deepEqual(parseThreadPickupPackage(serialized), result);
  assert.equal(threadPickupFilename("../../My thread"), "My-thread.mezair-thread");
  assert.throws(() => buildThreadPickupPackage(bundle, "share_123"), /author/);
});

test("pickup parser rejects authentication fields, paths, executable structure and bad references", () => {
  const good = pickup();
  for (const malicious of [
    { ...good, shareKey: "secret" },
    { ...good, accessToken: "secret" },
    { ...good, source: { ...good.source, viewerUrl: "https://viewer.example/artifacts/share_123#k=secret" } },
    { ...good, source: { ...good.source, viewerUrl: "https://viewer.example/artifacts/share_123?key=secret" } },
    { ...good, source: { ...good.source, viewerUrl: "https://viewer.example/artifacts/other" } },
    { ...good, source: { ...good.source, viewerUrl: "https://viewer.example/artifacts/share_123#" } },
    { ...good, source: { ...good.source, viewerUrl: "https://viewer.example/artifacts/share_123?" } },
    { ...good, source: { ...good.source, viewerUrl: "http://viewer.example/artifacts/share_123" } },
    { ...good, files: [{ ...good.files[0], name: "../private.txt" }] },
    { ...good, files: [{ ...good.files[0], path: "/private/secret" }] },
    { ...good, continuation: { ...good.continuation, permissions: "full-access" } },
    { ...good, continuation: { ...good.continuation, entries: [{ ...continuation.entries[0], role: "system" }] } },
    { ...good, continuation: { ...good.continuation, items: [{ kind: "artifact", title: "File", fileIndex: 1 }] } },
    { ...good, continuation: { ...good.continuation, items: [{ kind: "artifact", title: "File", command: "run" }] } },
  ]) assert.throws(() => parseThreadPickupPackage(JSON.stringify(malicious)), /invalid/);
});

test("pickup limits apply to UTF8 text, combined snapshots, file bytes and the whole package", () => {
  assert.throws(() => validateThreadContinuation({ ...continuation, entries: [{ ...continuation.entries[0], text: "é".repeat(MAX_THREAD_PICKUP_TEXT_BYTES / 2 + 1) }] }, 1), /limits/);
  assert.throws(() => parseThreadPickupPackage(JSON.stringify({ ...pickup(), snapshot: { html: "a".repeat(MAX_THREAD_PICKUP_TEXT_BYTES), css: "x" } })), /limits/);
  const oversizedFiles = [{ name: "large.bin", mediaType: "application/octet-stream", dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }];
  assert.throws(() => parseThreadPickupPackage(JSON.stringify({ ...pickup(), files: oversizedFiles })), /limits/);
  const nearLimitFiles = [{ ...oversizedFiles[0], dataBase64: Buffer.alloc(8 * 1024 * 1024).toString("base64") }];
  assert.throws(() => parseThreadPickupPackage(JSON.stringify({ ...pickup(), files: nearLimitFiles, snapshot: { html: "a".repeat(2 * 1024 * 1024), css: "" } })), /limits/);
});


test("pickup explains the plaintext copy before download and old snapshots request an author update", () => {
  const old = renderToStaticMarkup(createElement(ThreadPickupDownload, { bundle, shareId: "share_123" }));
  assert.match(old, /ask the author to update/i);
  assert.doesNotMatch(old, /mezair:\/\/|Pick up the thread<\//);
  const ready = renderToStaticMarkup(createElement(ThreadPickupDownload, { bundle: { ...bundle, continuation }, shareId: "share_123" }));
  assert.match(ready, /Anyone with the file can read it/);
  assert.match(ready, /Pick up the thread/);
  assert.doesNotMatch(ready, /href="mezair:/);
});
