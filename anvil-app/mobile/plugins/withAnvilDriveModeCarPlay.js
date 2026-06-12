const { withDangerousMod, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const GROUP_NAME = 'AnvilDriveMode';
const CARPLAY_DELEGATE = `${GROUP_NAME}/AnvilDriveSceneDelegate.swift`;
const BRIDGE_SWIFT = `${GROUP_NAME}/AnvilDriveModeBridge.swift`;
const BRIDGE_OBJC = `${GROUP_NAME}/AnvilDriveModeBridge.m`;
const SHORTCUTS_FILE = `${GROUP_NAME}/AnvilDriveShortcuts.swift`;

function withAnvilDriveModeCarPlay(config) {
  const carPlayEnabled = process.env.ANVIL_ENABLE_CARPLAY === 'true';
  const shortcutsEnabled = process.env.ANVIL_ENABLE_SIRI_SHORTCUTS === 'true';

  if (!carPlayEnabled && !shortcutsEnabled) return config;

  config = withInfoPlist(config, (config) => {
    if (carPlayEnabled) {
      config.modResults.UIApplicationSceneManifest = {
        ...(config.modResults.UIApplicationSceneManifest ?? {}),
        UIApplicationSupportsMultipleScenes: true,
        UISceneConfigurations: {
          ...((config.modResults.UIApplicationSceneManifest ?? {}).UISceneConfigurations ?? {}),
          CPTemplateApplicationSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Anvil Drive',
              UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).AnvilDriveSceneDelegate',
            },
          ],
        },
      };
    }
    return config;
  });

  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const bundleId = config.ios?.bundleIdentifier;
      if (!bundleId) return config;
      await writeDriveModeSources(
        config.modRequest.platformProjectRoot,
        carPlayEnabled,
        shortcutsEnabled,
        getAppGroupIdentifier(bundleId),
      );
      return config;
    },
  ]);

  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const bundleId = config.ios?.bundleIdentifier;
    if (!bundleId) return config;

    const appTarget = getApplicationTarget(project, bundleId);
    if (!appTarget) return config;

    const group = ensureGroup(project, GROUP_NAME);
    if (carPlayEnabled) {
      addSourceFileIfMissing(project, CARPLAY_DELEGATE, appTarget.uuid, group.uuid);
      addSourceFileIfMissing(project, BRIDGE_SWIFT, appTarget.uuid, group.uuid);
      addSourceFileIfMissing(project, BRIDGE_OBJC, appTarget.uuid, group.uuid);
    }
    if (shortcutsEnabled)
      addSourceFileIfMissing(project, SHORTCUTS_FILE, appTarget.uuid, group.uuid);
    setSwiftBuildSettings(project, bundleId);
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

function getApplicationTarget(project, iosBundleId) {
  for (const [uuid, target] of Object.entries(project.pbxNativeTargetSection())) {
    if (!target || uuid.endsWith('_comment')) continue;
    if (target.productType !== '"com.apple.product-type.application"') continue;
    const configurations = Object.values(project.pbxXCBuildConfigurationSection()).filter(
      (config) => config?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${iosBundleId}"`,
    );
    if (configurations.length > 0) return { uuid, target };
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

function setSwiftBuildSettings(project, iosBundleId) {
  for (const [, config] of Object.entries(project.pbxXCBuildConfigurationSection())) {
    if (!config || !config.buildSettings) continue;
    const settings = config.buildSettings;
    if (settings.PRODUCT_BUNDLE_IDENTIFIER !== `"${iosBundleId}"`) continue;
    settings.SWIFT_VERSION = settings.SWIFT_VERSION ?? '5.0';
  }
}

async function writeDriveModeSources(iosRoot, carPlayEnabled, shortcutsEnabled, appGroupIdentifier) {
  const root = path.join(iosRoot, GROUP_NAME);
  await fs.mkdir(root, { recursive: true });
  if (carPlayEnabled) {
    await fs.writeFile(
      path.join(root, 'AnvilDriveSceneDelegate.swift'),
      carPlaySwift(appGroupIdentifier),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'AnvilDriveModeBridge.swift'),
      bridgeSwift(appGroupIdentifier),
      'utf8',
    );
    await fs.writeFile(path.join(root, 'AnvilDriveModeBridge.m'), bridgeObjC(), 'utf8');
  }
  if (shortcutsEnabled) {
    await fs.writeFile(path.join(root, 'AnvilDriveShortcuts.swift'), shortcutsSwift(), 'utf8');
  }
}

function carPlaySwift(appGroupIdentifier) {
  return `import CarPlay
import Foundation
import UIKit

private let anvilDriveAppGroup = "${appGroupIdentifier}"
private let anvilDriveConnectionKey = "anvil.drive.connection.v1"
private let anvilDriveSnapshotKey = "anvil.drive.snapshot.v1"

final class AnvilDriveSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var snapshot: [String: Any] = [:]

  func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
    self.interfaceController = interfaceController
    self.snapshot = loadSnapshot()
    interfaceController.setRootTemplate(makeRootTemplate(), animated: false)
    reloadRoot()
  }

  func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
    self.interfaceController = nil
  }

  private func makeRootTemplate() -> CPListTemplate {
    let approvals = (snapshot["approvals"] as? [[String: Any]] ?? []).prefix(5).map { approval in
      let item = CPListItem(
        text: approval["title"] as? String ?? "Approval",
        detailText: approval["carPlayApprovable"] as? Bool == true ? approval["summary"] as? String ?? "Low-risk action" : "Requires desktop review"
      )
      item.handler = { [weak self] _, completion in
        self?.showApproval(approval)
        completion()
      }
      return item
    }

    let sessionItems = (snapshot["sessions"] as? [[String: Any]] ?? []).prefix(5).map { session in
      let item = CPListItem(text: session["title"] as? String ?? "Session", detailText: session["summary"] as? String ?? "Agent session")
      item.handler = { [weak self] _, completion in
        if let id = session["id"] as? String {
          self?.post("/api/carplay/sessions/\\(Self.escape(id))/pause") { self?.reloadRoot() }
        }
        completion()
      }
      return item
    }

    let pauseAll = CPListItem(text: "Pause all", detailText: "Interrupt active turns safely")
    pauseAll.handler = { [weak self] _, completion in
      self?.post("/api/carplay/sessions/pause-all") { self?.reloadRoot() }
      completion()
    }

    let handover = CPListItem(text: "Prepare handover", detailText: "Run on the paired desktop host")
    handover.handler = { [weak self] _, completion in
      self?.post("/api/carplay/handover") { self?.reloadRoot() }
      completion()
    }

    let attention = CPListSection(
      items: approvals.isEmpty ? [CPListItem(text: "No approvals waiting", detailText: "Unsafe actions stay on desktop")] : Array(approvals),
      header: "Attention",
      sectionIndexTitle: nil
    )
    let sessions = CPListSection(
      items: sessionItems.isEmpty ? [CPListItem(text: "No active sessions", detailText: "Nothing needs attention")] : Array(sessionItems),
      header: "Sessions",
      sectionIndexTitle: nil
    )
    let safeActions = CPListSection(
      items: [pauseAll, handover, CPListItem(text: "Capture note", detailText: "Use Siri Shortcuts or iPhone dictation")],
      header: "Safe Actions",
      sectionIndexTitle: nil
    )

    let template = CPListTemplate(title: "Anvil Drive", sections: [attention, sessions, safeActions])
    template.tabTitle = "Drive"
    return template
  }

  private func showApproval(_ approval: [String: Any]) {
    let canApprove = approval["carPlayApprovable"] as? Bool == true
    var items = [
      CPListItem(
        text: approval["requestedAction"] as? String ?? "Requested action",
        detailText: canApprove ? "Low-risk action" : "Requires desktop review"
      )
    ]

    guard let id = approval["id"] as? String else { return }
    if canApprove {
      let approve = CPListItem(text: "Approve", detailText: "Low-risk action")
      approve.handler = { [weak self] _, completion in
        self?.post("/api/carplay/approvals/\\(Self.escape(id))/approve") { self?.reloadRoot() }
        completion()
      }
      items.append(approve)
    }

    let decline = CPListItem(text: "Decline", detailText: "Reject this request")
    decline.handler = { [weak self] _, completion in
      self?.post("/api/carplay/approvals/\\(Self.escape(id))/decline") { self?.reloadRoot() }
      completion()
    }
    items.append(decline)

    let later = CPListItem(text: "Review later", detailText: "Send to desktop review")
    later.handler = { [weak self] _, completion in
      self?.post("/api/carplay/approvals/\\(Self.escape(id))/later") { self?.reloadRoot() }
      completion()
    }
    items.append(later)

    let template = CPListTemplate(
      title: approval["title"] as? String ?? "Approval",
      sections: [CPListSection(items: items, header: nil, sectionIndexTitle: nil)]
    )
    interfaceController?.pushTemplate(template, animated: true)
  }

  private func reloadRoot() {
    fetchSnapshot { [weak self] nextSnapshot in
      guard let self else { return }
      self.snapshot = nextSnapshot ?? self.loadSnapshot()
      self.interfaceController?.setRootTemplate(self.makeRootTemplate(), animated: true)
    }
  }

  private func loadSnapshot() -> [String: Any] {
    guard
      let defaults = UserDefaults(suiteName: anvilDriveAppGroup),
      let data = defaults.data(forKey: anvilDriveSnapshotKey),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
  }

  private func fetchSnapshot(_ completion: @escaping ([String: Any]?) -> Void) {
    request("/api/carplay", method: "GET", body: nil, completion: completion)
  }

  private func post(_ path: String, completion: @escaping () -> Void) {
    request(path, method: "POST", body: Data("{}".utf8)) { _ in completion() }
  }

  private func request(_ path: String, method: String, body: Data?, completion: @escaping ([String: Any]?) -> Void) {
    guard
      let defaults = UserDefaults(suiteName: anvilDriveAppGroup),
      let data = defaults.data(forKey: anvilDriveConnectionKey),
      let connection = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let baseUrl = connection["baseUrl"] as? String,
      let token = connection["token"] as? String,
      let url = URL(string: baseUrl + path)
    else {
      completion(nil)
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body

    URLSession.shared.dataTask(with: request) { data, _, _ in
      var result: [String: Any]?
      if let data {
        result = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      }
      DispatchQueue.main.async {
        if let data, path == "/api/carplay" {
          defaults.set(data, forKey: anvilDriveSnapshotKey)
        }
        completion(result)
      }
    }.resume()
  }

  private static func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
  }
}
`;
}

function bridgeSwift(appGroupIdentifier) {
  return `import Foundation
import React

private let anvilDriveAppGroup = "${appGroupIdentifier}"
private let anvilDriveConnectionKey = "anvil.drive.connection.v1"
private let anvilDriveSnapshotKey = "anvil.drive.snapshot.v1"

@objc(AnvilDriveModeBridge)
final class AnvilDriveModeBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(writeConnection:resolver:rejecter:)
  func writeConnection(_ payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    write(payload, key: anvilDriveConnectionKey, resolver: resolve, rejecter: reject)
  }

  @objc(writeSnapshot:resolver:rejecter:)
  func writeSnapshot(_ payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    write(payload, key: anvilDriveSnapshotKey, resolver: resolve, rejecter: reject)
  }

  @objc(clearConnection:rejecter:)
  func clearConnection(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let defaults = UserDefaults(suiteName: anvilDriveAppGroup) else {
      reject("ANVIL_DRIVE_APP_GROUP_UNAVAILABLE", "Unable to open the Anvil App Group store.", nil)
      return
    }
    defaults.removeObject(forKey: anvilDriveConnectionKey)
    defaults.removeObject(forKey: anvilDriveSnapshotKey)
    defaults.synchronize()
    resolve(true)
  }

  private func write(_ payload: NSDictionary, key: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let defaults = UserDefaults(suiteName: anvilDriveAppGroup) else {
      reject("ANVIL_DRIVE_APP_GROUP_UNAVAILABLE", "Unable to open the Anvil App Group store.", nil)
      return
    }
    do {
      let data = try JSONSerialization.data(withJSONObject: payload, options: [])
      defaults.set(data, forKey: key)
      defaults.synchronize()
      resolve(true)
    } catch {
      reject("ANVIL_DRIVE_WRITE_FAILED", "Failed to write Anvil Drive state.", error)
    }
  }
}
`;
}

function bridgeObjC() {
  return `#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AnvilDriveModeBridge, NSObject)

RCT_EXTERN_METHOD(writeConnection:(NSDictionary *)payload
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(writeSnapshot:(NSDictionary *)payload
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearConnection:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
`;
}

function shortcutsSwift() {
  return `import AppIntents
import Foundation

@available(iOS 16.0, *)
struct AnvilPrepareHandoverIntent: AppIntent {
  static var title: LocalizedStringResource = "Prepare Anvil Handover"
  static var description = IntentDescription("Ask the paired desktop host to prepare a handover.")

  func perform() async throws -> some IntentResult {
    UserDefaults.standard.set("prepare-handover", forKey: "anvil.pendingShortcut.v1")
    return .result()
  }
}

@available(iOS 16.0, *)
struct AnvilPauseAllIntent: AppIntent {
  static var title: LocalizedStringResource = "Pause Anvil Sessions"
  static var description = IntentDescription("Pause active Anvil agent sessions on the paired host.")

  func perform() async throws -> some IntentResult {
    UserDefaults.standard.set("pause-all", forKey: "anvil.pendingShortcut.v1")
    return .result()
  }
}

@available(iOS 16.0, *)
struct AnvilDriveShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    [
      AppShortcut(
        intent: AnvilPrepareHandoverIntent(),
        phrases: ["Prepare Anvil handover", "Prepare handover in \\(.applicationName)"],
        shortTitle: "Prepare handover",
        systemImageName: "doc.text"
      ),
      AppShortcut(
        intent: AnvilPauseAllIntent(),
        phrases: ["Pause Anvil sessions", "Pause sessions in \\(.applicationName)"],
        shortTitle: "Pause sessions",
        systemImageName: "pause.circle"
      )
    ]
  }
}
`;
}

module.exports = withAnvilDriveModeCarPlay;
