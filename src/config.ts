import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://lorepanic.com";

export interface Credentials {
  apiUrl: string;
  token: string;
  tokenExpiresAt: string;
  user: { id: string; email: string | null; display_name: string | null };
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "lorepanic");
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export function loadCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // mkdirSync's mode only applies to directories it creates; tighten an
  // existing config dir too, since it holds a long-lived API token.
  chmodSync(configDir(), 0o700);
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteCredentials(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function requireCredentials(): Credentials {
  const creds = loadCredentials();
  if (!creds) {
    console.error("Not logged in. Run `lorepanic login` first.");
    process.exit(1);
  }
  if (new Date(creds.tokenExpiresAt).getTime() < Date.now()) {
    console.error("Your session has expired. Run `lorepanic login` again.");
    process.exit(1);
  }
  return creds;
}
