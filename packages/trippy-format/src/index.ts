// .trippy project file schema and serialization helpers.
//
// A .trippy bundle is a JSON document plus one or more audio source files.
// Persisted as a zip on disk (see apps/web/src/project/persistence.ts) and
// in memory as the structures below.
//
// Schema is versioned. Breaking changes bump SCHEMA_VERSION; loaders may
// migrate older versions forward in `migrate()`.

export const SCHEMA_VERSION = 1;

export interface ProjectFile {
  schemaVersion: number;
  meta: ProjectMeta;
  transport: TransportSnapshot;
  sources: SourceMeta[];
  tracks: TrackSnapshot[];
}

export interface ProjectMeta {
  /** Stable project UUID. Generated on first save. */
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  modifiedAt: string;
  /** Schema-aware notes for humans — never trusted by load logic. */
  notes?: string;
}

export interface TransportSnapshot {
  sampleRate: number;
  bpm: number;
  positionFrames: number;
  loop?: { start: number; end: number };
}

export interface SourceMeta {
  /** Stable id used by clips to reference this source. */
  id: number;
  /** File name inside the bundle's `audio/` directory. */
  file: string;
  sampleRate: number;
  channels: number;
  frameCount: number;
  /** Original file name (preserved for the library view). */
  originalName?: string;
  /** SHA-256 of the audio bytes, hex. Used to dedupe & verify bundle integrity. */
  sha256?: string;
}

export interface TrackSnapshot {
  id: number;
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  color?: string;
  clips: ClipSnapshot[];
}

export interface ClipSnapshot {
  id: number;
  sourceId: number;
  startFrame: number;
  lengthFrames: number;
  offsetInSource: number;
  gain: number;
  /** Optional caption shown on the clip in the timeline. */
  label?: string;
}

export function newProject(name = "untitled"): ProjectFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      modifiedAt: now,
    },
    transport: {
      sampleRate: 48_000,
      bpm: 120,
      positionFrames: 0,
    },
    sources: [],
    tracks: [],
  };
}

/** Migrate older schemas forward. Throws on unrecognized versions. */
export function migrate(raw: unknown): ProjectFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("project: not an object");
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.schemaVersion;
  if (v === SCHEMA_VERSION) return obj as unknown as ProjectFile;
  if (typeof v !== "number") throw new Error("project: missing schemaVersion");
  // No older versions to migrate from yet.
  throw new Error(`project: unsupported schemaVersion ${v}`);
}

export function serialize(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

export function parse(json: string): ProjectFile {
  return migrate(JSON.parse(json));
}
