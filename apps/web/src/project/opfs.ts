// OPFS persistence for .trippy project bundles.
//
// A project is stored under OPFS as a directory:
//
//   /projects/{uuid}/
//     project.json     — serialized ProjectFile
//     audio/
//       src-1.wav      — raw bytes per source
//       src-2.wav
//       ...
//
// OPFS gives us a persistent, sandboxed FS visible only to the origin —
// perfect for offline-first DAW state. Quotas are generous (many GB).

import { serialize, parse, type ProjectFile } from "@trippy/format";

const PROJECTS_DIR = "projects";

async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

async function projectsDir(): Promise<FileSystemDirectoryHandle> {
  const r = await root();
  return await r.getDirectoryHandle(PROJECTS_DIR, { create: true });
}

async function projectDir(id: string): Promise<FileSystemDirectoryHandle> {
  const p = await projectsDir();
  return await p.getDirectoryHandle(id, { create: true });
}

export async function listProjects(): Promise<
  Array<{ id: string; name: string; modifiedAt: string }>
> {
  const dir = await projectsDir();
  const out: Array<{ id: string; name: string; modifiedAt: string }> = [];
  // @ts-expect-error — FileSystemDirectoryHandle is async-iterable per spec.
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "directory") continue;
    try {
      const projHandle = await (handle as FileSystemDirectoryHandle).getFileHandle(
        "project.json",
      );
      const f = await projHandle.getFile();
      const json = await f.text();
      const proj = parse(json);
      out.push({ id: name, name: proj.meta.name, modifiedAt: proj.meta.modifiedAt });
    } catch {
      /* skip malformed entries */
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

export async function saveProject(
  project: ProjectFile,
  sourceBytes: Map<number, ArrayBuffer>,
): Promise<void> {
  const dir = await projectDir(project.meta.id);
  // Write project.json
  const writeText = async (name: string, text: string) => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  };
  await writeText("project.json", serialize(project));

  // Write audio bytes
  const audioDir = await dir.getDirectoryHandle("audio", { create: true });
  for (const [id, bytes] of sourceBytes) {
    const meta = project.sources.find((s) => s.id === id);
    if (!meta) continue;
    const fh = await audioDir.getFileHandle(meta.file, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }
}

export async function loadProject(
  id: string,
): Promise<{ project: ProjectFile; sourceBytes: Map<number, ArrayBuffer> }> {
  const dir = await projectDir(id);
  const projHandle = await dir.getFileHandle("project.json");
  const json = await (await projHandle.getFile()).text();
  const project = parse(json);
  const sourceBytes = new Map<number, ArrayBuffer>();
  try {
    const audioDir = await dir.getDirectoryHandle("audio");
    for (const src of project.sources) {
      try {
        const fh = await audioDir.getFileHandle(src.file);
        const f = await fh.getFile();
        sourceBytes.set(src.id, await f.arrayBuffer());
      } catch {
        // Missing audio is non-fatal at load — the UI will mark the source as offline.
      }
    }
  } catch {
    /* no audio dir yet */
  }
  return { project, sourceBytes };
}

export async function deleteProject(id: string): Promise<void> {
  const p = await projectsDir();
  await p.removeEntry(id, { recursive: true });
}

/** True if the runtime supports OPFS. */
export function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}
