import {
  CopilotClient,
  approveAll,
  type SessionEvent,
  type SessionConfig,
  type MCPServerConfig,
} from '@github/copilot-sdk';
import fs from 'fs';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface CopilotQueryResult {
  newSessionId?: string;
  closedDuringQuery: boolean;
}

type WriteOutputFn = (output: ContainerOutput) => void;
type LogFn = (message: string) => void;
type ShouldCloseFn = () => boolean;
type DrainIpcFn = () => string[];

let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient({ autoStart: true, logLevel: 'error' });
  }
  return copilotClient;
}

export async function stopCopilotClient(): Promise<void> {
  if (copilotClient) {
    try { await copilotClient.stop(); } catch { /* ignore */ }
    copilotClient = null;
  }
}

export async function runCopilotQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  _sdkEnv: Record<string, string | undefined>,
  writeOutput: WriteOutputFn,
  log: LogFn,
  shouldClose: ShouldCloseFn,
  drainIpcInput: DrainIpcFn,
  ipcPollMs: number,
): Promise<CopilotQueryResult> {
  const client = getCopilotClient();

  if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    const which = process.env.COPILOT_GITHUB_TOKEN ? 'COPILOT_GITHUB_TOKEN' : process.env.GH_TOKEN ? 'GH_TOKEN' : 'GITHUB_TOKEN';
    log(`Copilot auth: using ${which} env var`);
  } else {
    log('Copilot auth: using signed-in user credentials (keychain/CLI fallback)');
  }

  const mcpServers: Record<string, MCPServerConfig> = {
    nanoclaw: {
      type: 'local',
      tools: ['*'],
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };

  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  const systemMessage =
    !containerInput.isMain && fs.existsSync(globalClaudeMd)
      ? fs.readFileSync(globalClaudeMd, 'utf-8')
      : undefined;

  const model = process.env.COPILOT_MODEL || 'gpt-4.1';
  const sessionConfig: SessionConfig = {
    model,
    streaming: true,
    mcpServers,
    onPermissionRequest: approveAll,
    ...(systemMessage ? { systemMessage: { content: systemMessage } } : {}),
  };

  log(`Creating Copilot session (model: ${model}, resume: ${sessionId || 'new'})`);

  const session = sessionId
    ? await client.resumeSession(sessionId, { model, onPermissionRequest: approveAll })
    : await client.createSession(sessionConfig);

  const newSessionId = session.sessionId;
  log(`Copilot session ready: ${newSessionId}`);

  let ipcPolling = true;
  let closedDuringQuery = false;

  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during Copilot query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    for (const text of drainIpcInput()) {
      session.send({ prompt: text }).catch((err: Error) => {
        log(`Failed to pipe IPC message: ${err.message}`);
      });
    }
    setTimeout(pollIpc, ipcPollMs);
  };
  setTimeout(pollIpc, ipcPollMs);

  return new Promise<CopilotQueryResult>((resolve, reject) => {
    let resultEmitted = false;

    session.on((event: SessionEvent) => {
      if (event.type === 'assistant.message') {
        const content = event.data.content || '';
        if (content) {
          log(`Copilot result (${content.length} chars): ${content.slice(0, 200)}`);
          writeOutput({ status: 'success', result: content, newSessionId });
          resultEmitted = true;
        }
      } else if (event.type === 'session.idle') {
        ipcPolling = false;
        if (!resultEmitted) {
          writeOutput({ status: 'success', result: null, newSessionId });
        }
        resolve({ newSessionId, closedDuringQuery });
      } else if (event.type === 'session.error') {
        ipcPolling = false;
        const errorMsg = event.data.message || 'Copilot session error';
        log(`Copilot error: ${errorMsg}`);
        writeOutput({ status: 'error', result: null, newSessionId, error: errorMsg });
        resolve({ newSessionId, closedDuringQuery });
      }
    });

    session.send({ prompt }).catch((err: Error) => {
      ipcPolling = false;
      reject(err);
    });
  });
}
