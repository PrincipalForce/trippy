// Cloud sync + collaboration scaffolding.
//
// **Architecture (target, M8):**
//   - Backend: Cloudflare Workers + R2 (sample CDN) + Durable Objects (CRDT room)
//   - Auth: passkeys via WebAuthn; session token in HttpOnly cookie
//   - Project sync: project.json as a Yjs doc, edits broadcast through a
//     Durable Object to all collaborators; conflict-free by construction
//   - Sample sync: large audio uploaded to R2, addressed by sha-256
//   - Offline-first: local OPFS is canonical; sync layer reconciles when
//     online
//
// **Status:** types + a stub client that the UI can call against. The real
// Workers endpoints are defined in `infra/workers/` (a separate package
// that ships independently of the web app).

export interface CloudProjectRef {
  id: string;
  name: string;
  ownerId: string;
  collaborators: string[];
  modifiedAt: string;
  /** True if there's a newer version on the server than our local copy. */
  hasUpdates?: boolean;
}

export interface CloudClient {
  /** Sign in with a passkey. */
  signInWithPasskey(): Promise<{ userId: string }>;
  /** List all projects accessible to the current user. */
  listProjects(): Promise<CloudProjectRef[]>;
  /** Push the local project as the newest snapshot. */
  pushProject(projectId: string, bundle: ArrayBuffer): Promise<void>;
  /** Pull the newest snapshot from the cloud. */
  pullProject(projectId: string): Promise<ArrayBuffer>;
  /** Subscribe to live CRDT updates for a project. */
  subscribe(
    projectId: string,
    onUpdate: (update: Uint8Array) => void,
  ): Promise<() => void>;
}

class StubCloudClient implements CloudClient {
  async signInWithPasskey(): Promise<{ userId: string }> {
    throw new Error("cloud auth not deployed yet (see docs/M8-cloud.md)");
  }
  async listProjects(): Promise<CloudProjectRef[]> {
    return [];
  }
  async pushProject(): Promise<void> {
    throw new Error("cloud sync not deployed yet");
  }
  async pullProject(): Promise<ArrayBuffer> {
    throw new Error("cloud sync not deployed yet");
  }
  async subscribe(): Promise<() => void> {
    return () => {};
  }
}

let _client: CloudClient = new StubCloudClient();

export function getCloudClient(): CloudClient {
  return _client;
}

/** Used by tests to inject a fake client. */
export function setCloudClient(c: CloudClient) {
  _client = c;
}
