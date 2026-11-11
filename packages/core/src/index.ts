export { defaultDataRoot, dataPaths, type DataPaths } from './paths.ts';
export { atomicWriteFile, type AtomicDeps } from './fs/atomic-write.ts';
export { SecretSet, REDACTED } from './secrets/redact.ts';
export {
  SecretStore,
  SecretPersistError,
  type KeyCrypto,
  type SecretStoreOptions,
} from './secrets/store.ts';
export {
  Kernel,
  KernelError,
  type KernelState,
  type OpenOptions,
  type OnboardingInput,
  type AddProviderInput,
  type ImageInput,
} from './kernel.ts';
export type { KernelEvent } from './events.ts';
export { listPresets } from './config/presets.ts';
export { callModel, testConnection, type CallModel, type TestConnectionResult } from './model/client.ts';
export {
  startServer,
  type ServerHandle,
  type ServerOptions,
} from './server/server.ts';
export type { StoredMessage, Block, AssistantResult, Delta, Usage, ImageMediaType } from './model/types.ts';
export type { ThreadUsage, SearchHit } from './db/messages.ts';
export type { ApprovalLogEntry } from './db/approval-log.ts';
export type { Thread } from './db/threads.ts';
export type {
  Bot,
  Provider,
  Preset,
  KnownModel,
  CustomModel,
  AppConfig,
  ApiFormat,
  ThinkingLevel,
  ApprovalMode,
} from './config/types.ts';
export type { ApprovalRequest } from './approval/broker.ts';
export type { Revision, RevisionSource } from './memory/revisions.ts';
export { RemoteService, type RemoteStatus, type RemoteConfig, type Device } from './remote/service.ts';
