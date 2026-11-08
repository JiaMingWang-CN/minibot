import type { MemoryRevisions } from '../memory/revisions.ts';
import type { DataPaths } from '../paths.ts';
import type { SecretSet } from '../secrets/redact.ts';
import type { ReadTracker } from './read-tracker.ts';

export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface FileCtx {
  tracker: ReadTracker;
  secrets: SecretSet;
  revisions: MemoryRevisions;
  paths: DataPaths;
  actor: string;
}
