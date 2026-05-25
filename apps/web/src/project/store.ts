// Project store: the canonical in-memory state of the open project, plus
// undo/redo. Solid stores give us fine-grained reactivity; the patch-based
// undo log keeps memory bounded and avoids deep-cloning the whole project on
// every edit.

import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import {
  newProject,
  type ProjectFile,
  type TrackSnapshot,
  type ClipSnapshot,
  type SourceMeta,
} from "@trippy/format";

export interface ProjectStore {
  project: ProjectFile;
  dirty: boolean;
  /** Undo stack (oldest-first). Each entry is a *previous* snapshot. */
  undo: ProjectFile[];
  redo: ProjectFile[];
}

const UNDO_LIMIT = 50;

export function createProjectStore(initial?: ProjectFile) {
  const [state, setState] = createStore<ProjectStore>({
    project: initial ?? newProject(),
    dirty: false,
    undo: [],
    redo: [],
  });

  function snapshot(): ProjectFile {
    // Cheap deep clone — projects without audio data are tiny JSON.
    return JSON.parse(JSON.stringify(state.project)) as ProjectFile;
  }

  function commit(mut: (draft: ProjectFile) => void) {
    const before = snapshot();
    setState(
      "project",
      produce((draft) => {
        mut(draft);
        draft.meta.modifiedAt = new Date().toISOString();
      }),
    );
    setState("dirty", true);
    setState("undo", (u) => {
      const next = [...u, before];
      if (next.length > UNDO_LIMIT) next.shift();
      return next;
    });
    setState("redo", []);
  }

  return {
    state,
    setState: setState as SetStoreFunction<ProjectStore>,
    commit,

    addSource(source: SourceMeta) {
      commit((p) => {
        p.sources.push(source);
      });
    },

    addTrack(name = "track"): number {
      const id = nextTrackId(state.project);
      commit((p) => {
        p.tracks.push({
          id,
          name,
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          clips: [],
        });
      });
      return id;
    },

    removeTrack(trackId: number) {
      commit((p) => {
        const i = p.tracks.findIndex((t) => t.id === trackId);
        if (i >= 0) p.tracks.splice(i, 1);
      });
    },

    updateTrack(trackId: number, patch: Partial<TrackSnapshot>) {
      commit((p) => {
        const t = p.tracks.find((tr) => tr.id === trackId);
        if (t) Object.assign(t, patch);
      });
    },

    addClip(trackId: number, clip: Omit<ClipSnapshot, "id">): number | null {
      const t = state.project.tracks.find((tr) => tr.id === trackId);
      if (!t) return null;
      const id = nextClipId(state.project);
      commit((p) => {
        const tt = p.tracks.find((tr) => tr.id === trackId);
        if (tt) tt.clips.push({ id, ...clip });
      });
      return id;
    },

    updateClip(trackId: number, clipId: number, patch: Partial<ClipSnapshot>) {
      commit((p) => {
        const t = p.tracks.find((tr) => tr.id === trackId);
        if (!t) return;
        const c = t.clips.find((cl) => cl.id === clipId);
        if (c) Object.assign(c, patch);
      });
    },

    removeClip(trackId: number, clipId: number) {
      commit((p) => {
        const t = p.tracks.find((tr) => tr.id === trackId);
        if (!t) return;
        const i = t.clips.findIndex((cl) => cl.id === clipId);
        if (i >= 0) t.clips.splice(i, 1);
      });
    },

    setBpm(bpm: number) {
      commit((p) => {
        p.transport.bpm = bpm;
      });
    },

    setLoop(loop: { start: number; end: number } | undefined) {
      commit((p) => {
        if (loop) p.transport.loop = { ...loop };
        else delete p.transport.loop;
      });
    },

    rename(name: string) {
      commit((p) => {
        p.meta.name = name;
      });
    },

    undo(): boolean {
      if (state.undo.length === 0) return false;
      const prev = state.undo[state.undo.length - 1]!;
      const current = snapshot();
      setState("project", prev);
      setState("undo", (u) => u.slice(0, -1));
      setState("redo", (r) => [...r, current]);
      setState("dirty", true);
      return true;
    },

    redo(): boolean {
      if (state.redo.length === 0) return false;
      const next = state.redo[state.redo.length - 1]!;
      const current = snapshot();
      setState("project", next);
      setState("redo", (r) => r.slice(0, -1));
      setState("undo", (u) => [...u, current]);
      setState("dirty", true);
      return true;
    },

    markClean() {
      setState("dirty", false);
    },

    replace(project: ProjectFile) {
      setState("project", project);
      setState("undo", []);
      setState("redo", []);
      setState("dirty", false);
    },
  };
}

function nextTrackId(p: ProjectFile): number {
  return (p.tracks.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;
}

function nextClipId(p: ProjectFile): number {
  let max = 0;
  for (const t of p.tracks) for (const c of t.clips) max = Math.max(max, c.id);
  return max + 1;
}

export type Project = ReturnType<typeof createProjectStore>;
