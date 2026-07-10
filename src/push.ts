import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ApiClient, ApiError, type NoteResponse } from "./api.js";
import { requireCredentials } from "./config.js";
import { findWorkspaceRoot, loadState, safeResolve, saveState, sha256 } from "./state.js";
import { frontMatter, parseFrontMatter } from "./workspace.js";

export interface PushOptions {
  prune?: boolean;
  force?: boolean;
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(path));
    else if (entry.name.endsWith(".md") && !entry.name.endsWith(".remote.md")) out.push(path);
  }
  return out;
}

function titleFromBody(body: string, fallback: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

function noteFile(note: NoteResponse, body: string): string {
  const content =
    frontMatter({
      id: note.id,
      type: "note",
      title: note.title ?? "Untitled",
      note_type: note.note_type,
      session_id: note.session_id,
      updated_at: note.updated_at,
    }) + body;
  return content.endsWith("\n") ? content : content + "\n";
}

export async function push(opts: PushOptions): Promise<void> {
  const creds = requireCredentials();
  const cwd = process.cwd();
  const root = findWorkspaceRoot(cwd);
  if (!root) {
    console.error("Not a campaign workspace (no .lorepanic/state.json). Run `lorepanic pull` first.");
    process.exit(1);
  }
  const state = loadState(root);
  if (!state) {
    console.error("Could not read .lorepanic/state.json.");
    process.exit(1);
  }
  const api = new ApiClient(creds.apiUrl, creds.token);

  // Map previously synced note paths to their entity ids, so a file whose
  // front-matter was stripped by an overzealous edit still updates in place
  // instead of duplicating.
  const idByPath = new Map<string, string>();
  for (const [id, entity] of Object.entries(state.entities)) {
    if (entity.type !== "note") continue;
    const file = entity.files["content"];
    if (file) idByPath.set(file.path, id);
  }

  const stats = { created: 0, updated: 0, unchanged: 0, conflicts: 0, deleted: 0 };
  const seenIds = new Set<string>();

  for (const abs of listMarkdownFiles(join(root, "notes"))) {
    const rel = relative(root, abs).split("\\").join("/");
    const raw = readFileSync(abs, "utf-8");
    const parsed = parseFrontMatter(raw);
    const id = (parsed?.fields["id"] as string | undefined) ?? idByPath.get(rel);
    const body = (parsed ? parsed.body : raw).replace(/\n$/, "");

    if (id && state.entities[id]) {
      seenIds.add(id);
      const entity = state.entities[id];
      const prevFile = entity.files["content"];
      if (prevFile && prevFile.path === rel && sha256(raw) === prevFile.hash) {
        stats.unchanged += 1;
        continue;
      }

      const payload: Record<string, unknown> = {
        title: (parsed?.fields["title"] as string | undefined) ?? titleFromBody(body, rel),
        content: body,
      };
      if (parsed?.fields["note_type"]) payload["note_type"] = parsed.fields["note_type"];
      if (!opts.force) payload["expected_updated_at"] = entity.updated_at;

      let note: NoteResponse;
      try {
        note = await api.put<NoteResponse>(`/api/notes/${id}`, payload);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          console.log(
            `  ! ${rel}: the note changed on the server. Run \`lorepanic pull\` to get a ` +
              `.remote.md copy, merge, then \`lorepanic push --force\`.`,
          );
          stats.conflicts += 1;
          continue;
        }
        throw e;
      }

      const content = noteFile(note, body);
      writeFileSync(abs, content);
      state.entities[id] = {
        type: "note",
        updated_at: note.updated_at,
        files: { content: { path: rel, hash: sha256(content) } },
      };
      const remote = abs.replace(/\.md$/, ".remote.md");
      if (opts.force && existsSync(remote)) unlinkSync(remote);
      console.log(`  ^ ${rel}`);
      stats.updated += 1;
      continue;
    }

    // New note.
    const note = await api.post<NoteResponse>(`/api/notes/campaigns/${state.campaignId}`, {
      title: (parsed?.fields["title"] as string | undefined) ?? titleFromBody(body, rel.replace(/^notes\//, "").replace(/\.md$/, "")),
      content: body,
      note_type: (parsed?.fields["note_type"] as string | undefined) ?? "gm",
    });
    seenIds.add(note.id);
    const content = noteFile(note, body);
    writeFileSync(abs, content);
    state.entities[note.id] = {
      type: "note",
      updated_at: note.updated_at,
      files: { content: { path: rel, hash: sha256(content) } },
    };
    console.log(`  + ${rel} (created on server)`);
    stats.created += 1;
  }

  // Notes tracked in state whose local file disappeared.
  for (const [id, entity] of Object.entries(state.entities)) {
    if (entity.type !== "note" || seenIds.has(id)) continue;
    const file = entity.files["content"];
    if (!file) continue;
    const abs = safeResolve(root, file.path);
    if (!abs) {
      console.log(`  ! state entry for ${file.path} points outside the workspace; ignored`);
      continue;
    }
    if (existsSync(abs)) continue;
    if (opts.prune) {
      try {
        await api.delete(
          `/api/notes/${id}?expected_updated_at=${encodeURIComponent(entity.updated_at)}`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          console.log(
            `  ! ${file.path}: the note changed on the server since your last pull; ` +
              `run \`lorepanic pull\` to restore it before deciding to delete.`,
          );
          stats.conflicts += 1;
          continue;
        }
        throw e;
      }
      delete state.entities[id];
      console.log(`  - ${file.path} (deleted on server)`);
      stats.deleted += 1;
    } else {
      console.log(`  ? ${file.path} deleted locally; use \`lorepanic push --prune\` to delete on the server, or \`lorepanic pull\` to restore it`);
    }
  }

  saveState(root, state);
  const summary = [
    `${stats.created} created`,
    `${stats.updated} updated`,
    `${stats.unchanged} unchanged`,
    stats.deleted > 0 ? `${stats.deleted} deleted` : null,
    stats.conflicts > 0 ? `${stats.conflicts} conflict(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`Done: ${summary}.`);
}
