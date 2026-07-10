#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "./api.js";
import { DEFAULT_API_URL } from "./config.js";
import { login, logout } from "./login.js";
import { listCampaigns, pull } from "./pull.js";
import { push } from "./push.js";

const HELP = `lorepanic: sync your LorePanic campaigns to a local folder

Usage:
  lorepanic login [--api-url <url>] [--no-browser]
                                      Connect this machine to your account
  lorepanic pull [--campaign <name|id>] [--dir <path>]
                                      Download or refresh a campaign workspace
  lorepanic push [--prune] [--force]  Send changed/new notes back to LorePanic
  lorepanic sync                      Push, then pull
  lorepanic campaigns                 List your campaigns
  lorepanic logout                    Forget the local credentials
  lorepanic help                      Show this message

A workspace is a folder of markdown (documents, notes, characters, session
transcripts) that coding agents like Claude Code understand natively. Edit
notes/, create new .md files there, then \`lorepanic push\` to sync them back.
`;

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    }
  }
  return { command, flags };
}

function version(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "login":
      await login(flags["api-url"] ?? DEFAULT_API_URL, flags["no-browser"] === "true");
      break;
    case "logout":
      logout();
      break;
    case "campaigns":
      await listCampaigns();
      break;
    case "pull":
      await pull({ campaign: flags["campaign"], dir: flags["dir"] });
      break;
    case "push":
      await push({ prune: flags["prune"] === "true", force: flags["force"] === "true" });
      break;
    case "sync":
      await push({});
      await pull({});
      break;
    case "--version":
    case "version":
      console.log(version());
      break;
    case "help":
    case "--help":
    default:
      console.log(HELP);
      break;
  }
}

main().catch((e: unknown) => {
  if (e instanceof ApiError && e.status === 401) {
    console.error("Authentication failed. Run `lorepanic login` again.");
  } else {
    console.error((e as Error).message ?? e);
  }
  process.exit(1);
});
