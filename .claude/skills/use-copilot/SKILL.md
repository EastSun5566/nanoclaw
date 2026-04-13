---
name: use-copilot
description: Switch the agent runner from Claude to GitHub Copilot. Sets NANOCLAW_SDK=copilot and configures credentials (GITHUB_TOKEN or OAuth login). Use when the user wants to run agents with GitHub Copilot instead of Anthropic Claude. Triggers on "use copilot", "switch to copilot", "copilot backend", "use github copilot".
---

# Use GitHub Copilot as Agent Backend

Switches agent containers from the Anthropic Claude Agent SDK to the GitHub Copilot SDK. No code changes required — support is already built in. This skill only handles configuration and credentials.

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

If `NANOCLAW_SDK=copilot` is already set, skip to Phase 3 (Verify).

## Phase 2: Configure

### Choose authentication method

AskUserQuestion: How do you want to authenticate GitHub Copilot?

- **GITHUB_TOKEN** — paste a personal access token or GitHub App token with Copilot access
- **OAuth login** — run `copilot auth login` interactively (stores credentials in `~/.copilot/`)

**If GITHUB_TOKEN:**

Add to `.env`:

```
GITHUB_TOKEN=ghp_your_token_here
```

Ask the user to paste their token, then write it.

**If OAuth login:**

Run:

```bash
npx @github/copilot auth login
```

Follow the prompts. When done, confirm credentials exist:

```bash
ls ~/.copilot/ && echo "OK"
```

The `~/.copilot/` directory is automatically bind-mounted into containers read-only — no further configuration needed.

### Set the SDK backend

Add to `.env`:

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

## Phase 3: Rebuild Container

The agent-runner must be rebuilt to pick up the `@github/copilot-sdk` dependency:

```bash
./container/build.sh
```

This takes a minute or two. Wait for it to finish.

## Phase 4: Restart Service

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

## Phase 5: Verify

Send a test message from your channel. Check logs for confirmation:

```bash
tail -f logs/nanoclaw.log | grep -E "SDK backend|Copilot auth|Copilot session"
```

You should see:

```
Using SDK backend: copilot
Copilot auth: using GITHUB_TOKEN env var   (or: using OAuth credentials)
Creating Copilot session (model: gpt-4.1, resume: new)
Copilot session ready: <sessionId>
```

## Switching Back to Claude

To revert to Claude, remove or comment out `NANOCLAW_SDK` in `.env`:

```bash
sed -i '' 's/^NANOCLAW_SDK=copilot/# NANOCLAW_SDK=copilot/' .env
```

Then restart the service.

## Troubleshooting

**"No Copilot authentication found"** — `GITHUB_TOKEN` is not set and `~/.copilot/` is missing. Re-run Phase 2.

**"Cannot find module '@github/copilot-sdk'"** — Container was not rebuilt. Run `./container/build.sh`.

**Copilot session error / 401** — Token lacks Copilot access. Ensure the PAT has `copilot` scope or your account has an active Copilot subscription.

**Model not found** — Check available models in your Copilot plan. Fall back to `gpt-4.1` by unsetting `COPILOT_MODEL`.
