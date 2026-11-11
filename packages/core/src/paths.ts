import os from 'node:os';
import path from 'node:path';

export interface DataPaths {
  root: string;
  config: string;
  secrets: string;
  userMd: string;
  remoteJson: string;
  remoteKey: string;
  devicesJson: string;
  db: string;
  outputs: string;
  attachments: string;
  botsDir: string;
  botDir(id: string): string;
  botJson(id: string): string;
  memoryDir(id: string): string;
  defaultWorkspace(id: string): string;
}

export function defaultDataRoot(): string {
  return path.join(os.homedir(), '.minibot');
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    config: path.join(root, 'config.json'),
    secrets: path.join(root, 'secrets.bin'),
    userMd: path.join(root, 'user.md'),
    remoteJson: path.join(root, 'remote.json'),
    remoteKey: path.join(root, 'remote-key.bin'),
    devicesJson: path.join(root, 'devices.json'),
    db: path.join(root, 'minibot.db'),
    outputs: path.join(root, 'outputs'),
    attachments: path.join(root, 'attachments'),
    botsDir: path.join(root, 'bots'),
    botDir: (id) => path.join(root, 'bots', id),
    botJson: (id) => path.join(root, 'bots', id, 'bot.json'),
    memoryDir: (id) => path.join(root, 'bots', id, 'memory'),
    defaultWorkspace: (id) => path.join(root, 'workspaces', id),
  };
}
