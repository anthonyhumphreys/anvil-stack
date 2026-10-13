// Inline surface contract shared by main and renderer.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §5.

import type { Feature } from '../types.js';

/** Minimal JSON Schema subset used for tool input and surface payload schemas. */
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  oneOf?: JsonSchema[];
  default?: unknown;
};

/** Built-in comment anchor types. Kinds declare which ones they support. */
export type SurfaceAnchorType =
  | 'surface'
  | 'diff-range'
  | 'finding'
  | 'chapter'
  | 'node'
  | 'row'
  | 'cell'
  | 'series-point'
  | 'step'
  | 'text-selection'
  | 'region';

export interface SurfaceAnchor {
  type: SurfaceAnchorType;
  /** Stable id within the surface payload (finding id, node id, row key…). */
  targetId?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  /** Quoted text for `text-selection`. */
  quote?: string;
  /** Normalised 0..1 rectangle for `region`. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Human-readable label shown next to the comment and sent to the agent. */
  label?: string;
}

export type SurfaceActionSemantics =
  /** Structured follow-up delivered to the agent (steer / prompt / queue). */
  | { type: 'agent-message'; template: string }
  /** Local, non-mutating or user-owned state change executed in main. */
  | { type: 'anvil-command'; command: string }
  /** External or repository mutation: runtime approval, hidden in read-only. */
  | { type: 'mutation'; command: string; approval: true };

export interface SurfaceActionSpec {
  label: string;
  semantics: SurfaceActionSemantics;
  shortcut?: string;
  /** Whether the action applies to selected targets (finding ids, rows…). */
  targets?: 'none' | 'one' | 'many';
}

/** Shared (process-neutral) definition of a surface kind. */
export interface SurfaceKindDefinition<P = unknown> {
  kind: string;
  label: string;
  /** Validated at the main-process trust boundary. */
  schema: JsonSchema;
  actions: Record<string, SurfaceActionSpec>;
  anchors: SurfaceAnchorType[];
  /** Compact plain-text summary (agent context, mobile, export, share fallback). */
  digest(payload: P): string;
  feature?: Feature;
  /** Wide surfaces break out of the reply column to the transcript width. */
  wide?: boolean;
  /** Whether the kind supports sharing (main provides the snapshot). */
  shareable?: boolean;
}

export interface SurfaceActionRequest {
  surfaceId: string;
  action: string;
  targetIds?: string[];
  note?: string;
}

export interface SurfaceActionResult {
  ok: boolean;
  /** Present when the action needs approval and is now waiting for it. */
  pendingApproval?: boolean;
  message?: string;
  error?: string;
}

export interface SurfaceComment {
  id: string;
  surfaceId: string;
  anchor: SurfaceAnchor;
  body: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceCommentInput {
  surfaceId: string;
  anchor: SurfaceAnchor;
  body: string;
  /** Send the comment to the agent as structured feedback now. */
  sendToAgent?: boolean;
}

/** Throwaway agent-authored visual (§8.10). */
export interface ChatSketch {
  id: string;
  threadId: string;
  sourceMessageId?: string;
  title: string;
  html: string;
  height?: number;
  keptArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Surface data payload for `surfaceKind: 'artifact'` intents. */
export interface ArtifactSurfaceData {
  artifactId: string;
  /** Version produced by this turn. */
  version: number;
  operation: 'created' | 'updated';
}

/** Surface data payload for `surfaceKind: 'sketch'` intents. */
export interface SketchSurfaceData {
  sketchId: string;
  height?: number;
}
