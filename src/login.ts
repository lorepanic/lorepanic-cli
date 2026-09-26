import { spawn } from "node:child_process";
import { hostname } from "node:os";

import { ApiClient, ApiError, NetworkError, type DevicePoll, type DeviceStart } from "./api.js";
import { DEFAULT_API_URL, deleteCredentials, saveCredentials } from "./config.js";

const SCOPES = ["sync:read", "notes:write", "campaigns:read", "me:read"];

function openBrowser(url: string): void {
  // `start` is a cmd built-in, not an executable, so Windows goes through
  // cmd /c. Spawn failures surface as async 'error' events; without the
  // listener they would crash the process instead of falling back to the
  // printed URL.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Non-fatal: the URL is printed either way.
    });
    child.unref();
  } catch {
    // Non-fatal: the URL is printed either way.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Consecutive network/5xx poll failures tolerated before giving up. */
const MAX_POLL_FAILURES = 8;

export async function login(apiUrl: string = DEFAULT_API_URL, noBrowser = false): Promise<void> {
  const api = new ApiClient(apiUrl);
  const start = await api.post<DeviceStart>("/api/cli/device/start", {
    client_name: `LorePanic CLI on ${hostname()}`,
    scopes: SCOPES,
  });

  console.log("");
  console.log(`  Your code: ${start.user_code}`);
  console.log("");
  console.log("  Approve this connection in your browser:");
  console.log(`  ${start.verification_url_complete}`);
  console.log("");
  if (!noBrowser) openBrowser(start.verification_url_complete);
  process.stdout.write("  Waiting for approval");

  const expiresAt = new Date(start.expires_at).getTime();
  let interval = Math.max(2, start.interval);

  // Consecutive transient failures (network, 5xx); reset on any real answer.
  let failures = 0;
  let waitSeconds = interval;

  while (Date.now() < expiresAt) {
    await sleep(waitSeconds * 1000);
    waitSeconds = interval;
    process.stdout.write(".");
    let poll: DevicePoll;
    try {
      poll = await api.post<DevicePoll>("/api/cli/device/poll", {
        device_code: start.device_code,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        // Rate limited: honor Retry-After and poll less often from now on.
        interval = Math.min(interval + 5, 60);
        waitSeconds = Math.max(interval, e.retryAfter ?? interval);
        continue;
      }
      if (e instanceof ApiError && e.status === 400 && /slow_down/.test(e.body)) {
        interval = Math.min(interval + 5, 60);
        waitSeconds = interval;
        continue;
      }
      const transient = e instanceof NetworkError || (e instanceof ApiError && e.status >= 500);
      if (!transient) throw e;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        console.log("");
        console.error(`Giving up after ${failures} failed attempts to reach LorePanic: ${(e as Error).message}`);
        process.exit(1);
      }
      // Exponential backoff, capped so we still notice approval promptly.
      waitSeconds = Math.min(interval * 2 ** failures, 60);
      continue;
    }
    failures = 0;
    if (poll.status === "slow_down") {
      interval = Math.min(Math.max(interval + 5, poll.interval ?? 0), 60);
      waitSeconds = interval;
      continue;
    }
    if (poll.status === "pending") {
      if (poll.interval) interval = Math.max(2, poll.interval);
      waitSeconds = interval;
      continue;
    }
    console.log("");
    if (poll.status === "connected" && poll.token && poll.token_expires_at) {
      saveCredentials({
        apiUrl,
        token: poll.token,
        tokenExpiresAt: poll.token_expires_at,
        user: poll.user ?? { id: "", email: null, display_name: null },
      });
      const who = poll.user?.email ?? poll.user?.display_name ?? "your account";
      console.log(`Logged in as ${who}.`);
      console.log("Next: run `lorepanic pull` inside the folder where you keep your campaigns.");
      return;
    }
    if (poll.status === "denied") {
      console.error("The connection was denied in the browser.");
      process.exit(1);
    }
    if (poll.status === "expired") break;
  }

  console.log("");
  console.error("The code expired before it was approved. Run `lorepanic login` again.");
  process.exit(1);
}

export function logout(): void {
  if (deleteCredentials()) {
    console.log("Logged out locally. To revoke the token server-side, visit your profile settings.");
  } else {
    console.log("You were not logged in.");
  }
}
