const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_SCENE_DELEGATE = 'AnvilCompanion/AnvilAppSceneDelegate.swift';
const WATCH_TARGET_NAME = 'AnvilWatch';
const WATCH_BUNDLE_SUFFIX = '.watchkitapp';
const WIDGET_TARGET_NAME = 'AnvilWidgets';
const WIDGET_BUNDLE_SUFFIX = '.widgets';
const WIDGET_BRIDGE_GROUP_NAME = 'AnvilWidgetBridge';
const WIDGET_SNAPSHOT_KEY = 'anvil.widget.snapshot.v1';
const WIDGET_UPDATED_AT_KEY = 'anvil.widget.updatedAt.v1';

function withAnvilCompanionSurfaces(config) {
  config = withInfoPlist(config, (config) => {
    const existingManifest = config.modResults.UIApplicationSceneManifest ?? {};
    config.modResults.UIApplicationSceneManifest = {
      ...existingManifest,
      UIApplicationSupportsMultipleScenes:
        existingManifest.UIApplicationSupportsMultipleScenes ?? false,
      UISceneConfigurations: {
        ...(existingManifest.UISceneConfigurations ?? {}),
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Anvil Main',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).AnvilAppSceneDelegate',
          },
        ],
      },
    };
    return config;
  });

  config = withEntitlementsPlist(config, (config) => {
    const bundleId = config.ios?.bundleIdentifier;
    if (!bundleId) return config;
    config.modResults['com.apple.security.application-groups'] = [
      getAppGroupIdentifier(bundleId),
    ];
    return config;
  });

  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const bundleId = config.ios?.bundleIdentifier;
      if (!bundleId) return config;
      await writeCompanionSurfaceSources(
        config.modRequest.platformProjectRoot,
        config.modRequest.projectName,
        bundleId,
        getAppGroupIdentifier(bundleId),
      );
      return config;
    },
  ]);

  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const bundleId = config.ios?.bundleIdentifier;
    if (!bundleId) return config;
    const appVersion = config.version ?? '1.0.0';

    ensureTargetDependencySections(project);

    const appTarget = getApplicationTarget(project, bundleId);
    if (appTarget) {
      const appGroup = ensureGroup(project, 'AnvilCompanion');
      addSourceFileIfMissing(project, APP_SCENE_DELEGATE, appTarget.uuid, appGroup.uuid);
      const bridgeGroup = ensureGroup(project, WIDGET_BRIDGE_GROUP_NAME);
      addSourceFileIfMissing(
        project,
        `${WIDGET_BRIDGE_GROUP_NAME}/AnvilWidgetBridge.swift`,
        appTarget.uuid,
        bridgeGroup.uuid,
      );
      addSourceFileIfMissing(
        project,
        `${WIDGET_BRIDGE_GROUP_NAME}/AnvilWidgetBridge.m`,
        appTarget.uuid,
        bridgeGroup.uuid,
      );
      setAppBridgeBuildSettings(project, bundleId);
    }

    let watchTarget = findTargetByName(project, WATCH_TARGET_NAME);
    if (!watchTarget) {
      const createdWatchTarget = project.addTarget(
        WATCH_TARGET_NAME,
        'watch2_app',
        WATCH_TARGET_NAME,
        `${bundleId}${WATCH_BUNDLE_SUFFIX}`,
      );
      watchTarget = { uuid: createdWatchTarget.uuid, target: createdWatchTarget.pbxNativeTarget };
      const watchGroup = ensureGroup(project, WATCH_TARGET_NAME);

      project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', watchTarget.uuid);
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', watchTarget.uuid);

      project.addSourceFile(
        `${WATCH_TARGET_NAME}/AnvilWatchApp.swift`,
        {
          target: watchTarget.uuid,
        },
        watchGroup.uuid,
      );
      project.addSourceFile(
        `${WATCH_TARGET_NAME}/CompanionRelay.swift`,
        {
          target: watchTarget.uuid,
        },
        watchGroup.uuid,
      );
    }
    setWatchBuildSettings(project, watchTarget.uuid, bundleId, appVersion);

    let widgetTarget = findTargetByName(project, WIDGET_TARGET_NAME);
    if (!widgetTarget) {
      const createdWidgetTarget = project.addTarget(
        WIDGET_TARGET_NAME,
        'app_extension',
        WIDGET_TARGET_NAME,
        `${bundleId}${WIDGET_BUNDLE_SUFFIX}`,
      );
      widgetTarget = { uuid: createdWidgetTarget.uuid, target: createdWidgetTarget.pbxNativeTarget };
      const widgetGroup = ensureGroup(project, WIDGET_TARGET_NAME);

      project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', widgetTarget.uuid);
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', widgetTarget.uuid);

      project.addSourceFile(
        `${WIDGET_TARGET_NAME}/AnvilWidgets.swift`,
        {
          target: widgetTarget.uuid,
        },
        widgetGroup.uuid,
      );
    }
    setWidgetBuildSettings(project, widgetTarget.uuid, bundleId, appVersion);

    if (appTarget) {
      ensureTargetDependency(project, appTarget.uuid, watchTarget.uuid);
      ensureTargetDependency(project, appTarget.uuid, widgetTarget.uuid);
    }

    return config;
  });
}

function ensureGroup(project, groupName) {
  const existing = project.pbxGroupByName(groupName);
  if (existing) {
    const uuid = project.findPBXGroupKey({ name: groupName });
    return { uuid, pbxGroup: existing };
  }
  return project.addPbxGroup([], groupName, groupName, '"<group>"');
}

function hasTarget(project, targetName) {
  return !!findTargetByName(project, targetName);
}

function findTargetByName(project, targetName) {
  for (const [uuid, target] of Object.entries(project.pbxNativeTargetSection())) {
    if (!target || uuid.endsWith('_comment')) continue;
    if (target.name === targetName || target.name === `"${targetName}"`) return { uuid, target };
  }
  return null;
}

function getApplicationTarget(project, iosBundleId) {
  for (const [uuid, target] of Object.entries(project.pbxNativeTargetSection())) {
    if (!target || uuid.endsWith('_comment')) continue;
    if (target.productType !== '"com.apple.product-type.application"') continue;
    const buildConfigurationList = target.buildConfigurationList;
    const configurations = Object.values(project.pbxXCBuildConfigurationSection()).filter(
      (config) => config?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${iosBundleId}"`,
    );
    if (buildConfigurationList || configurations.length > 0) return { uuid, target };
  }
  return project.getFirstTarget?.() ?? null;
}

function addSourceFileIfMissing(project, filePath, targetUuid, groupUuid) {
  if (project.hasFile(filePath)) return;
  project.addSourceFile(filePath, { target: targetUuid }, groupUuid);
}

function getAppGroupIdentifier(iosBundleId) {
  return `group.${iosBundleId}`;
}

function ensureTargetDependencySections(project) {
  project.hash.project.objects.PBXContainerItemProxy =
    project.hash.project.objects.PBXContainerItemProxy ?? {};
  project.hash.project.objects.PBXTargetDependency =
    project.hash.project.objects.PBXTargetDependency ?? {};
}

function ensureTargetDependency(project, targetUuid, dependencyTargetUuid) {
  if (hasTargetDependency(project, targetUuid, dependencyTargetUuid)) return;
  project.addTargetDependency(targetUuid, [dependencyTargetUuid]);
}

function hasTargetDependency(project, targetUuid, dependencyTargetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  if (!target?.dependencies?.length) return false;

  const dependencySection = project.hash.project.objects.PBXTargetDependency ?? {};
  return target.dependencies.some((dependency) => {
    const dependencyRef = dependencySection[dependency.value];
    return dependencyRef?.target === dependencyTargetUuid;
  });
}

function setAppBridgeBuildSettings(project, iosBundleId) {
  for (const [, config] of Object.entries(project.pbxXCBuildConfigurationSection())) {
    if (!config || !config.buildSettings) continue;
    const settings = config.buildSettings;
    if (settings.PRODUCT_BUNDLE_IDENTIFIER !== `"${iosBundleId}"`) continue;
    settings.SWIFT_VERSION = settings.SWIFT_VERSION ?? '5.0';
  }
}

function setWatchBuildSettings(project, targetUuid, iosBundleId, appVersion) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  if (target) target.productType = '"com.apple.product-type.application"';

  for (const [, config] of Object.entries(project.pbxXCBuildConfigurationSection())) {
    if (!config || !config.buildSettings) continue;
    const settings = config.buildSettings;
    if (settings.PRODUCT_BUNDLE_IDENTIFIER !== `"${iosBundleId}${WATCH_BUNDLE_SUFFIX}"`) continue;
    settings.ASSETCATALOG_COMPILER_APPICON_NAME = 'AppIcon';
    settings.CODE_SIGN_ENTITLEMENTS = `${WATCH_TARGET_NAME}/${WATCH_TARGET_NAME}.entitlements`;
    settings.CURRENT_PROJECT_VERSION = '1';
    settings.GENERATE_INFOPLIST_FILE = 'NO';
    settings.INFOPLIST_FILE = `${WATCH_TARGET_NAME}/Info.plist`;
    settings.MARKETING_VERSION = appVersion;
    settings.PRODUCT_NAME = WATCH_TARGET_NAME;
    settings.SDKROOT = 'watchos';
    settings.SKIP_INSTALL = 'YES';
    settings.SWIFT_VERSION = '5.0';
    settings.TARGETED_DEVICE_FAMILY = '4';
    settings.WATCHOS_DEPLOYMENT_TARGET = '10.0';
    settings.WK_APPLICATION = 'YES';
  }
}

function setWidgetBuildSettings(project, targetUuid, iosBundleId, appVersion) {
  for (const [, config] of Object.entries(project.pbxXCBuildConfigurationSection())) {
    if (!config || !config.buildSettings) continue;
    const settings = config.buildSettings;
    if (settings.PRODUCT_BUNDLE_IDENTIFIER !== `"${iosBundleId}${WIDGET_BUNDLE_SUFFIX}"`) continue;
    settings.ASSETCATALOG_COMPILER_APPICON_NAME = 'AppIcon';
    settings.CODE_SIGN_ENTITLEMENTS = `${WIDGET_TARGET_NAME}/${WIDGET_TARGET_NAME}.entitlements`;
    settings.CURRENT_PROJECT_VERSION = '1';
    settings.GENERATE_INFOPLIST_FILE = 'NO';
    settings.INFOPLIST_FILE = `${WIDGET_TARGET_NAME}/Info.plist`;
    settings.MARKETING_VERSION = appVersion;
    settings.PRODUCT_NAME = WIDGET_TARGET_NAME;
    settings.SDKROOT = 'iphoneos';
    settings.SKIP_INSTALL = 'YES';
    settings.SWIFT_VERSION = '5.0';
    settings.TARGETED_DEVICE_FAMILY = '"1,2"';
    settings.APPLICATION_EXTENSION_API_ONLY = 'YES';
    settings.IPHONEOS_DEPLOYMENT_TARGET = '17.0';
  }
}

async function writeCompanionSurfaceSources(
  iosRoot,
  projectName,
  iosBundleId,
  appGroupIdentifier,
) {
  const appRoot = path.join(iosRoot, projectName ?? 'AnvilCompanion');
  const watchRoot = path.join(iosRoot, WATCH_TARGET_NAME);
  const widgetRoot = path.join(iosRoot, WIDGET_TARGET_NAME);
  const widgetBridgeRoot = path.join(iosRoot, WIDGET_BRIDGE_GROUP_NAME);
  await fs.mkdir(appRoot, { recursive: true });
  await fs.mkdir(watchRoot, { recursive: true });
  await fs.mkdir(widgetRoot, { recursive: true });
  await fs.mkdir(widgetBridgeRoot, { recursive: true });

  await fs.writeFile(
    path.join(appRoot, 'AnvilAppSceneDelegate.swift'),
    appSceneDelegateSwift(),
    'utf8',
  );
  await patchAppDelegateForSceneLifecycle(path.join(appRoot, 'AppDelegate.swift'));

  await fs.writeFile(
    path.join(widgetBridgeRoot, 'AnvilWidgetBridge.swift'),
    widgetBridgeSwift(appGroupIdentifier),
    'utf8',
  );
  await fs.writeFile(path.join(widgetBridgeRoot, 'AnvilWidgetBridge.m'), widgetBridgeObjC(), 'utf8');

  await fs.writeFile(path.join(watchRoot, 'Info.plist'), watchInfoPlist(iosBundleId), 'utf8');
  await fs.writeFile(
    path.join(watchRoot, `${WATCH_TARGET_NAME}.entitlements`),
    entitlements(appGroupIdentifier),
    'utf8',
  );
  await fs.writeFile(path.join(watchRoot, 'AnvilWatchApp.swift'), watchAppSwift(), 'utf8');
  await fs.writeFile(path.join(watchRoot, 'CompanionRelay.swift'), companionRelaySwift(), 'utf8');

  await fs.writeFile(path.join(widgetRoot, 'Info.plist'), widgetInfoPlist(), 'utf8');
  await fs.writeFile(
    path.join(widgetRoot, `${WIDGET_TARGET_NAME}.entitlements`),
    entitlements(appGroupIdentifier),
    'utf8',
  );
  await fs.writeFile(
    path.join(widgetRoot, 'AnvilWidgets.swift'),
    widgetSwift(appGroupIdentifier),
    'utf8',
  );
}

async function patchAppDelegateForSceneLifecycle(appDelegatePath) {
  const source = await fs.readFile(appDelegatePath, 'utf8');
  if (source.includes('configureReactNativeFactoryIfNeeded()')) return;

  const startupBlock = `    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

  const nextSource = source
    .replace(
      startupBlock,
      `    configureReactNativeFactoryIfNeeded()

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`,
    )
    .replace(
      '\n  // Linking API\n',
      `
  func configureReactNativeFactoryIfNeeded() -> RCTReactNativeFactory {
    if let reactNativeFactory {
      return reactNativeFactory
    }

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

    return factory
  }

  // Linking API
`,
    );

  if (nextSource === source) {
    throw new Error('Unable to patch AppDelegate.swift for scene lifecycle support.');
  }

  await fs.writeFile(appDelegatePath, nextSource, 'utf8');
}

function appSceneDelegateSwift() {
  return `import React
import UIKit

final class AnvilAppSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    appDelegate.configureReactNativeFactoryIfNeeded().startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: nil
    )
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}
`;
}

function watchInfoPlist(iosBundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>WKCompanionAppBundleIdentifier</key>
  <string>${iosBundleId}</string>
  <key>CFBundleName</key>
  <string>Anvil</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>WKApplication</key>
  <true/>
</dict>
</plist>
`;
}

function widgetInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key>
  <string>Anvil Widgets</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;
}

function entitlements(appGroupIdentifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroupIdentifier}</string>
  </array>
</dict>
</plist>
`;
}

function widgetBridgeSwift(appGroupIdentifier) {
  return `import Foundation
import React
import WatchConnectivity
import WidgetKit

@objc(AnvilWidgetBridge)
final class AnvilWidgetBridge: RCTEventEmitter, WCSessionDelegate {
  private var hasActiveListeners = false
  private var pendingWatchReplies: [String: ([String: Any]) -> Void] = [:]

  override init() {
    super.init()
    configureWatchSession()
  }

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    ["AnvilWatchMessage"]
  }

  override func startObserving() {
    hasActiveListeners = true
    configureWatchSession()
  }

  override func stopObserving() {
    hasActiveListeners = false
  }

  @objc(writeSnapshot:resolver:rejecter:)
  func writeSnapshot(
    _ payload: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let defaults = UserDefaults(suiteName: "${appGroupIdentifier}") else {
      reject("ANVIL_WIDGET_APP_GROUP_UNAVAILABLE", "Unable to open the Anvil App Group store.", nil)
      return
    }

    do {
      let data = try JSONSerialization.data(withJSONObject: payload, options: [])
      defaults.set(data, forKey: "${WIDGET_SNAPSHOT_KEY}")
      defaults.set(Date().timeIntervalSince1970, forKey: "${WIDGET_UPDATED_AT_KEY}")
      defaults.synchronize()

      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
      }

      resolve(true)
    } catch {
      reject("ANVIL_WIDGET_SNAPSHOT_WRITE_FAILED", "Failed to write the Anvil widget snapshot.", error)
    }
  }

  @objc(clearSnapshot:rejecter:)
  func clearSnapshot(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let defaults = UserDefaults(suiteName: "${appGroupIdentifier}") else {
      reject("ANVIL_WIDGET_APP_GROUP_UNAVAILABLE", "Unable to open the Anvil App Group store.", nil)
      return
    }

    defaults.removeObject(forKey: "${WIDGET_SNAPSHOT_KEY}")
    defaults.removeObject(forKey: "${WIDGET_UPDATED_AT_KEY}")
    defaults.synchronize()

    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadAllTimelines()
    }

    resolve(true)
  }

  @objc(activateWatchRelay:rejecter:)
  func activateWatchRelay(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard WCSession.isSupported() else {
      resolve(false)
      return
    }

    configureWatchSession()
    resolve(true)
  }

  @objc(replyToWatchRequest:payload:resolver:rejecter:)
  func replyToWatchRequest(
    _ requestId: NSString,
    payload: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let key = requestId as String
    guard let reply = pendingWatchReplies.removeValue(forKey: key) else {
      resolve(false)
      return
    }

    reply(makeWatchSnapshotReply(payload))
    resolve(true)
  }

  private func configureWatchSession() {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    if session.activationState == .notActivated {
      session.activate()
    }
  }

  private func makeWatchSnapshotReply(_ payload: NSDictionary? = nil) -> [String: Any] {
    let approvalsJson = payload?["approvalsJson"] as? String ?? "[]"
    let threadsJson = payload?["threadsJson"] as? String ?? "[]"
    return [
      "approvals": Data(approvalsJson.utf8),
      "threads": Data(threadsJson.utf8)
    ]
  }

  private func receiveWatchMessage(_ message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    guard hasActiveListeners else {
      replyHandler(makeWatchSnapshotReply())
      return
    }

    let requestId = UUID().uuidString
    pendingWatchReplies[requestId] = replyHandler
    DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
      guard let self, let reply = self.pendingWatchReplies.removeValue(forKey: requestId) else { return }
      reply(self.makeWatchSnapshotReply())
    }

    sendEvent(withName: "AnvilWatchMessage", body: [
      "requestId": requestId,
      "message": message
    ])
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    DispatchQueue.main.async {
      self.receiveWatchMessage(message) { _ in }
    }
  }

  func session(
    _ session: WCSession,
    didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    DispatchQueue.main.async {
      self.receiveWatchMessage(message, replyHandler: replyHandler)
    }
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    WCSession.default.activate()
  }
}
`;
}

function widgetBridgeObjC() {
  return `#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AnvilWidgetBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(writeSnapshot:(NSDictionary *)payload
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearSnapshot:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(activateWatchRelay:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(replyToWatchRequest:(NSString *)requestId
                  payload:(NSDictionary *)payload
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
`;
}

function widgetSwift(appGroupIdentifier) {
  return `import SwiftUI
import WidgetKit

private let appGroupIdentifier = "${appGroupIdentifier}"
private let widgetSnapshotKey = "${WIDGET_SNAPSHOT_KEY}"

struct AnvilWidgetSnapshot: Codable {
  let version: Int
  let generatedAt: String
  let health: String
  let headline: String
  let detail: String
  let activeWorkspaceName: String?
  let counts: AnvilWidgetCounts
  let quickActions: [AnvilWidgetAction]
}

struct AnvilWidgetCounts: Codable {
  let pendingApprovals: Int
  let activeSessions: Int
  let busySessions: Int
  let readySessions: Int
  let recentThreads: Int
  let workspaceRepos: Int
}

struct AnvilWidgetAction: Codable, Identifiable {
  let id: String
  let title: String
  let subtitle: String
  let tone: String?
}

struct AnvilWidgetEntry: TimelineEntry {
  let date: Date
  let snapshot: AnvilWidgetSnapshot?
}

struct AnvilWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> AnvilWidgetEntry {
    AnvilWidgetEntry(date: Date(), snapshot: sampleSnapshot())
  }

  func getSnapshot(in context: Context, completion: @escaping (AnvilWidgetEntry) -> Void) {
    completion(AnvilWidgetEntry(date: Date(), snapshot: loadSnapshot() ?? sampleSnapshot()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<AnvilWidgetEntry>) -> Void) {
    let entry = AnvilWidgetEntry(date: Date(), snapshot: loadSnapshot())
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(300))))
  }

  private func loadSnapshot() -> AnvilWidgetSnapshot? {
    guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
          let data = defaults.data(forKey: widgetSnapshotKey) else {
      return nil
    }
    return try? JSONDecoder().decode(AnvilWidgetSnapshot.self, from: data)
  }

  private func sampleSnapshot() -> AnvilWidgetSnapshot {
    AnvilWidgetSnapshot(
      version: 1,
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      health: "busy",
      headline: "1 session working",
      detail: "Review progress, approvals, and launch the next useful task.",
      activeWorkspaceName: "Anvil",
      counts: AnvilWidgetCounts(
        pendingApprovals: 0,
        activeSessions: 1,
        busySessions: 1,
        readySessions: 0,
        recentThreads: 4,
        workspaceRepos: 2
      ),
      quickActions: fallbackActions()
    )
  }
}

struct AnvilCommandWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AnvilCommandWidget", provider: AnvilWidgetProvider()) { entry in
      AnvilWidgetView(entry: entry)
    }
    .configurationDisplayName("Anvil Command Deck")
    .description("Launch focused Anvil workflows from your Home Screen.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct AnvilWidgetView: View {
  let entry: AnvilWidgetEntry
  @Environment(\\.widgetFamily) private var family
  private var snapshot: AnvilWidgetSnapshot {
    entry.snapshot ?? fallbackSnapshot()
  }

  var body: some View {
    if family == .systemSmall {
      Link(destination: workflowUrl(snapshot.quickActions.first?.id ?? "status-sweep")) {
        VStack(alignment: .leading, spacing: 8) {
          HeaderRow(snapshot: snapshot, compact: true)
          Text(snapshot.headline)
            .font(.title3.bold())
            .lineLimit(2)
            .minimumScaleFactor(0.8)
          CountStrip(snapshot: snapshot)
          Text(snapshot.detail)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding()
        .containerBackground(.fill.tertiary, for: .widget)
      }
    } else {
      VStack(alignment: .leading, spacing: 9) {
        HeaderRow(snapshot: snapshot, compact: false)
        Text(snapshot.headline)
          .font(.title3.bold())
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        CountStrip(snapshot: snapshot)
        Text(snapshot.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
        HStack(spacing: 8) {
          ForEach(Array(snapshot.quickActions.prefix(4))) { action in
            WorkflowLink(title: shortActionTitle(action.title), actionId: action.id)
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .padding()
      .containerBackground(.fill.tertiary, for: .widget)
    }
  }
}

struct HeaderRow: View {
  let snapshot: AnvilWidgetSnapshot
  let compact: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(snapshot.activeWorkspaceName ?? "Anvil")
        .font(compact ? .caption.bold() : .headline)
        .lineLimit(1)
      Spacer(minLength: 4)
      Text(healthLabel(snapshot.health))
        .font(.caption2.bold())
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(healthColor(snapshot.health).opacity(0.16), in: Capsule())
        .foregroundStyle(healthColor(snapshot.health))
    }
  }
}

struct CountStrip: View {
  let snapshot: AnvilWidgetSnapshot

  var body: some View {
    HStack(spacing: 6) {
      CountPill(label: "OKs", value: snapshot.counts.pendingApprovals)
      CountPill(label: "Run", value: snapshot.counts.busySessions)
      CountPill(label: "Repos", value: snapshot.counts.workspaceRepos)
    }
  }
}

struct CountPill: View {
  let label: String
  let value: Int

  var body: some View {
    HStack(spacing: 3) {
      Text("\\(value)")
        .font(.caption.bold())
      Text(label)
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .background(.primary.opacity(0.07), in: Capsule())
  }
}

struct WorkflowLink: View {
  let title: String
  let actionId: String

  var body: some View {
    Link(destination: workflowUrl(actionId)) {
      Text(title)
        .font(.caption.bold())
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.orange.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
    }
  }
}

func fallbackSnapshot() -> AnvilWidgetSnapshot {
  AnvilWidgetSnapshot(
    version: 1,
    generatedAt: ISO8601DateFormatter().string(from: Date()),
    health: "unconfigured",
    headline: "Pair Anvil",
    detail: "Open the companion app to connect your Mac and publish live workflow state.",
    activeWorkspaceName: "Anvil",
    counts: AnvilWidgetCounts(
      pendingApprovals: 0,
      activeSessions: 0,
      busySessions: 0,
      readySessions: 0,
      recentThreads: 0,
      workspaceRepos: 0
    ),
    quickActions: fallbackActions()
  )
}

func fallbackActions() -> [AnvilWidgetAction] {
  [
    AnvilWidgetAction(id: "status-sweep", title: "Status sweep", subtitle: "Check active work", tone: "blue"),
    AnvilWidgetAction(id: "review-diff", title: "Review diff", subtitle: "Inspect changes", tone: "purple"),
    AnvilWidgetAction(id: "test-hunt", title: "Find tests", subtitle: "Run the right checks", tone: "green"),
    AnvilWidgetAction(id: "ship-handoff", title: "Ship handoff", subtitle: "Summarize release state", tone: "amber")
  ]
}

func workflowUrl(_ actionId: String) -> URL {
  URL(string: "anvil-companion://workflow/\\(actionId)")!
}

func healthLabel(_ health: String) -> String {
  switch health {
  case "needs-approval":
    return "Needs OK"
  case "busy":
    return "Working"
  case "ready":
    return "Ready"
  case "idle":
    return "Idle"
  default:
    return "Setup"
  }
}

func healthColor(_ health: String) -> Color {
  switch health {
  case "needs-approval":
    return .red
  case "busy":
    return .blue
  case "ready":
    return .green
  case "idle":
    return .gray
  default:
    return .orange
  }
}

func shortActionTitle(_ title: String) -> String {
  switch title {
  case "Status sweep":
    return "Status"
  case "Review diff":
    return "Review"
  case "Find tests":
    return "Tests"
  case "Ship handoff":
    return "Handoff"
  default:
    return title
  }
}

@main
struct AnvilWidgetBundle: WidgetBundle {
  var body: some Widget {
    AnvilCommandWidget()
  }
}
`;
}

function watchAppSwift() {
  return `import SwiftUI
import WatchKit

@main
struct AnvilWatchApp: App {
  @StateObject private var relay = CompanionRelay()

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        List {
          Section("Approvals") {
            if relay.approvals.isEmpty {
              Text("No pending approvals")
            } else {
              ForEach(relay.approvals) { approval in
                NavigationLink(approval.title) {
                  ApprovalDetailView(approval: approval, relay: relay)
                }
              }
            }
          }

          Section("Launch") {
            WorkflowButton(title: "Status sweep", actionId: "status-sweep")
            WorkflowButton(title: "Review diff", actionId: "review-diff")
            WorkflowButton(title: "Find tests", actionId: "test-hunt")
            WorkflowButton(title: "Ship handoff", actionId: "ship-handoff")
          }

          Section("Chats") {
            ForEach(relay.threads) { thread in
              NavigationLink(thread.title) {
                ChatReplyView(thread: thread, relay: relay)
              }
            }
          }
        }
        .navigationTitle("Anvil")
        .toolbar {
          Button {
            relay.refresh()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
        }
      }
      .onAppear { relay.activate() }
    }
  }
}

struct WorkflowButton: View {
  let title: String
  let actionId: String

  var body: some View {
    Button(title) {
      guard let url = URL(string: "anvil-companion://workflow/\\(actionId)") else { return }
      WKExtension.shared().openSystemURL(url)
    }
  }
}

struct ApprovalDetailView: View {
  let approval: WatchApproval
  @ObservedObject var relay: CompanionRelay

  var body: some View {
    List {
      Text(approval.detail).font(.caption)
      Button("Approve") { relay.resolve(approval, decision: "accept") }
      Button("Approve Session") { relay.resolve(approval, decision: "acceptForSession") }
      Button("Decline", role: .destructive) { relay.resolve(approval, decision: "decline") }
    }
    .navigationTitle("Approval")
  }
}

struct ChatReplyView: View {
  let thread: WatchThread
  @ObservedObject var relay: CompanionRelay
  @State private var message = ""

  var body: some View {
    List {
      Text(thread.preview).font(.caption)
      TextField("Dictate reply", text: $message)
      Button("Send") {
        relay.send(thread, message: message)
        message = ""
      }
      Button("Continue") { relay.send(thread, message: "Continue.") }
      Button("Stop") { relay.send(thread, message: "Stop.") }
      Button("Summarize") { relay.send(thread, message: "Summarize the current status.") }
      Button("Interrupt", role: .destructive) { relay.interrupt(thread) }
    }
    .navigationTitle(thread.title)
  }
}
`;
}

function companionRelaySwift() {
  return `import Foundation
import WatchConnectivity

struct WatchApproval: Identifiable, Codable {
  let id: String
  let sessionId: String
  let requestKey: String
  let title: String
  let detail: String
}

struct WatchThread: Identifiable, Codable {
  let id: String
  let title: String
  let preview: String
  let activeSessionId: String?
}

final class CompanionRelay: NSObject, ObservableObject, WCSessionDelegate {
  @Published var approvals: [WatchApproval] = []
  @Published var threads: [WatchThread] = []

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func refresh() {
    send(["type": "refresh"])
  }

  func resolve(_ approval: WatchApproval, decision: String) {
    send([
      "type": "resolveApproval",
      "sessionId": approval.sessionId,
      "requestKey": approval.requestKey,
      "decision": decision
    ])
  }

  func send(_ thread: WatchThread, message: String) {
    guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    send([
      "type": "sendMessage",
      "threadId": thread.id,
      "sessionId": thread.activeSessionId ?? "",
      "message": message
    ])
  }

  func interrupt(_ thread: WatchThread) {
    guard let sessionId = thread.activeSessionId else { return }
    send(["type": "interrupt", "sessionId": sessionId])
  }

  private func send(_ payload: [String: Any]) {
    guard WCSession.default.activationState == .activated else { return }
    WCSession.default.sendMessage(payload, replyHandler: handleSnapshot, errorHandler: nil)
  }

  private func handleSnapshot(_ message: [String: Any]) {
    DispatchQueue.main.async {
      if let approvalData = message["approvals"] as? Data,
         let approvals = try? JSONDecoder().decode([WatchApproval].self, from: approvalData) {
        self.approvals = approvals
      }
      if let threadData = message["threads"] as? Data,
         let threads = try? JSONDecoder().decode([WatchThread].self, from: threadData) {
        self.threads = threads
      }
    }
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
}
`;
}

module.exports = withAnvilCompanionSurfaces;
