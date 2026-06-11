/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Companion Base URL - Base URL shown when creating a Raycast token in desktop app settings. */
  "baseUrl": string,
  /** Companion Token - Bearer token created from desktop app settings for this Raycast extension. */
  "token": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `overview` command */
  export type Overview = ExtensionPreferences & {}
  /** Preferences accessible in the `approvals` command */
  export type Approvals = ExtensionPreferences & {}
  /** Preferences accessible in the `chats` command */
  export type Chats = ExtensionPreferences & {}
  /** Preferences accessible in the `launch-workflow` command */
  export type LaunchWorkflow = ExtensionPreferences & {}
  /** Preferences accessible in the `open-desktop` command */
  export type OpenDesktop = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `overview` command */
  export type Overview = {}
  /** Arguments passed to the `approvals` command */
  export type Approvals = {}
  /** Arguments passed to the `chats` command */
  export type Chats = {}
  /** Arguments passed to the `launch-workflow` command */
  export type LaunchWorkflow = {}
  /** Arguments passed to the `open-desktop` command */
  export type OpenDesktop = {}
}

