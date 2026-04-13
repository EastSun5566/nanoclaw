---
name: use-copilot
description: Switch the agent runner from Claude to GitHub Copilot. Sets NANOCLAW_SDK=copilot and configures credentials (COPILOT_GITHUB_TOKEN). Use when the user wants to run agents with GitHub Copilot instead of Anthropic Claude. Triggers on "use copilot", "switch to copilot", "copilot backend", "use github copilot".
---

# Use GitHub Copilot as Agent Backend

Switches agent containers from the Anthropic Claude Agent SDK to the GitHub Copilot SDK. No code changes required — support is already built in. This skill only handles configuration and credentials.

Two authentication options:

- **Token** (recommended) — paste a GitHub PAT into `.env`. Works immediately, no interactive setup.
- **OAuth device flow** — run `copilot login` interactively. The `copilot` binary ships inside the container as a dependency of `@github/copilot-sdk`. It does NOT exist on the host.

## Phase 1: Pre-flight

### Confirm support is present

```bash
test -f container/agent-runner/src/copilot.ts && echo "OK" || echo "MISSING"
```

If `MISSING`, run `/update-nanoclaw` first to pull the latest changes, then retry this skill.

### Check current backend

```bash
grep "NANOCLAW_SDK" .env 2>/dev/null || echo "not set (defaults to claude)"
```

If `NANOCLAW_SDK=copilot` is already set, skip to Phase 4 (Verify).

## Phase 2: Authenticate

AskUserQuestion: How do you want to authenticate?

- **Token** — create a fine-grained PAT on GitHub and paste it into `.env`
- **OAuth login** — run `copilot login` device flow inside the container (requires container to be built first)

---

### Option A: Token

The SDK reads `COPILOT_GITHUB_TOKEN` from the environment.

**Token requirements:**

- Must be a **fine-grained PAT** or **OAuth token** (`gho_` / `ghu_` prefix)
- Classic PATs (`ghp_` prefix) are **not supported** by the Copilot SDK
- Your GitHub account must have an active Copilot subscription

**How to create a fine-grained PAT:**

1. Go to https://github.com/settings/personal-access-tokens/new
2. Give it a name (e.g. `nanoclaw-copilot`)
3. Set expiration as needed
4. Under **Permissions → Account permissions**, grant `GitHub Copilot` → `Read-only`
5. Click **Generate token** and copy it

Ask the user to paste the token. Verify it does not start with `ghp_`. Add to `.env`:

```
COPILOT_GITHUB_TOKEN=<paste token here>
```

Skip to Phase 3.

---

### Option B: OAuth device flow

The `copilot` binary is bundled inside the container (via `@github/copilot-sdk` → `@github/copilot` npm package). It is not available on the host OS. We run it once interactively to complete device flow and persist the credentials to a host directory.

**Step 1: Build the container first** (skip if already built)

```bash
./container/build.sh
```

**Step 2: Determine your container runtime** (Docker or Apple Container)

```bash
docker info &>/dev/null && echo "docker" || echo "apple-container"
```

**Step 3: Create the credential directory on the host**

```bash
mkdir -p ~/.nanoclaw-copilot
```

**Step 4: Run one-off interactive login**

For Docker:

```bash
docker run -it --rm \
  -v "$HOME/.nanoclaw-copilot:/home/node/.config/github-copilot" \
  --user node \
  nanoclaw-agent \
  bash -c "/app/node_modules/.bin/copilot login"
```

For Apple Container:

```bash
container run -it --rm \
  --volume "$HOME/.nanoclaw-copilot:/home/node/.config/github-copilot" \
  --user node \
  nanoclaw-agent \
  bash -c "/app/node_modules/.bin/copilot login"
```

Follow the device flow: it prints a code and a URL. Open the URL in your browser, enter the code, and authorize.

**Step 5: Verify credentials were saved**

```bash
ls ~/.nanoclaw-copilot/
```

You should see a `hosts.json` file (or similar). If the directory is empty, the binary may store creds in a different path — check inside the container:

```bash
docker run -it --rm --user node nanoclaw-agent bash -c \
  "ls /home/node/.config/ /home/node/.local/share/ 2>/dev/null"
```

Identify the correct path and repeat Step 3-4 with the matching host-to-container mount.

**Step 6: Enable the credential mount**

The host directory `~/.nanoclaw-copilot` will be passed into all future containers. Add to `.env`:

```
COPILOT_OAUTH_DIR=~/.nanoclaw-copilot
```

Then update `src/container-runner.ts` — in `buildVolumeMounts`, add:

```typescript
const copilotOAuthDir = process.env.COPILOT_OAUTH_DIR?.replace(
  /^~/,
  process.env.HOME || '/root',
);
if (copilotOAuthDir && fs.existsSync(copilotOAuthDir)) {
  mounts.push({
    hostPath: copilotOAuthDir,
    containerPath: '/home/node/.config/github-copilot',
    readonly: true,
  });
}
```

---

## Phase 3: Configure

Enable the Copilot backend. Add to `.env`:

```
NANOCLAW_SDK=copilot
```

### Set model (optional)

AskUserQuestion: Which Copilot model do you want to use? (Leave blank for default: gpt-4.1)

If the user provides a model name, add to `.env`:

```
COPILOT_MODEL=<model>
```

Available models include: `gpt-4.1`, `gpt-4o`, `claude-3.7-sonnet`, `o3`.

### Rebuild container

The agent-runner must be rebuilt to pick up the `@github/copilot-sdk` dependency inside the container:

```bash
./container/build.sh
```

This takes a minute or two. Wait for it to finish.

### Restart service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Or if running in dev mode, stop and rerun:

```bash
npm run dev
```

## Phase 4: Verify

Send a test message from your channel. Check logs for confirmation:

```bash
tail -f logs/nanoclaw.log | grep -E "SDK backend|Copilot auth|Copilot session"
```

You should see:

```
Using SDK backend: copilot
Copilot auth: using COPILOT_GITHUB_TOKEN env var
Creating Copilot session (model: gpt-4.1, resume: new)
Copilot session ready: <sessionId>
```

## Switching Back to Claude

To revert to Claude, remove or comment out `NANOCLAW_SDK` in `.env`:

```bash
# macOS
sed -i '' 's/^NANOCLAW_SDK=copilot/# NANOCLAW_SDK=copilot/' .env

# Linux
sed -i 's/^NANOCLAW_SDK=copilot/# NANOCLAW_SDK=copilot/' .env
```

Then restart the service.

## Troubleshooting

**"No Copilot authentication found"** — `COPILOT_GITHUB_TOKEN` is not set or the container was not restarted after editing `.env`. Check `.env`, then restart the service.

**"Cannot find module '@github/copilot-sdk'"** — Container was not rebuilt after adding the SDK. Run `./container/build.sh`.

**Copilot session error / 401 Unauthorized** — Token is invalid or lacks Copilot access. Verify the token is not a classic PAT (`ghp_`), and that the GitHub account has an active Copilot subscription. Generate a new fine-grained PAT and update `.env`.

**Token starts with `ghp_` (classic PAT)** — Classic tokens are not supported. Generate a fine-grained PAT at https://github.com/settings/personal-access-tokens/new instead.

**Model not found** — Check available models for your Copilot plan. Remove `COPILOT_MODEL` from `.env` to fall back to `gpt-4.1`.
