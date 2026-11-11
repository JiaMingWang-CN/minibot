// 手机端（远程来源）能调用的接口白名单；表外一律拒绝。
interface Rule {
  method: string;
  pattern: RegExp;
}

const SEG = '[^/]+';

const RULES: readonly Rule[] = [
  { method: 'GET', pattern: /^\/api\/state$/ },
  { method: 'GET', pattern: /^\/api\/running$/ },
  { method: 'GET', pattern: /^\/api\/approvals$/ },
  { method: 'GET', pattern: /^\/api\/search$/ },
  { method: 'GET', pattern: new RegExp(`^/api/bots/${SEG}/threads$`) },
  { method: 'GET', pattern: new RegExp(`^/api/threads/${SEG}/messages$`) },
  { method: 'GET', pattern: new RegExp(`^/api/threads/${SEG}$`) },
  { method: 'GET', pattern: new RegExp(`^/api/threads/${SEG}/usage$`) },
  { method: 'GET', pattern: new RegExp(`^/api/attachments/${SEG}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/bots/${SEG}/threads$`) },
  { method: 'POST', pattern: new RegExp(`^/api/threads/${SEG}/messages$`) },
  { method: 'PATCH', pattern: new RegExp(`^/api/threads/${SEG}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/threads/${SEG}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/threads/${SEG}/retry$`) },
];

export function isRemoteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pattern.test(pathname));
}

export { REMOTE_FORBIDDEN } from '../server/dispatch.ts';
