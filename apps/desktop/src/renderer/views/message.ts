import type { Block, StoredMessage } from '@minibot/core';
import { t } from '../i18n/index.js';

function statusLabel(status: string): string {
  if (status === 'ok') return t('message.status.ok');
  if (status === 'error') return t('message.status.error');
  if (status === 'denied') return t('message.status.denied');
  return t('message.status.cancelled');
}

function blockElement(block: Block): HTMLElement | null {
  if (block.type === 'text') {
    const node = document.createElement('div');
    node.className = 'block-text';
    node.textContent = block.text;
    return node;
  }
  if (block.type === 'reasoning') {
    const details = document.createElement('details');
    details.className = 'block-details block-reasoning';
    const summary = document.createElement('summary');
    summary.textContent = t('message.thinking');
    const body = document.createElement('div');
    body.className = 'block-body';
    body.textContent = block.text;
    details.append(summary, body);
    return details;
  }
  if (block.type === 'tool_use') {
    const details = document.createElement('details');
    details.className = 'block-details block-tool';
    const summary = document.createElement('summary');
    summary.textContent = t('message.toolUse', { name: block.name });
    const body = document.createElement('pre');
    body.className = 'block-body';
    body.textContent = JSON.stringify(block.input, null, 2);
    details.append(summary, body);
    return details;
  }
  const details = document.createElement('details');
  details.className = 'block-details block-result';
  const summary = document.createElement('summary');
  summary.textContent = t('message.toolResult', { status: statusLabel(block.status) });
  const body = document.createElement('pre');
  body.className = 'block-body';
  body.textContent = block.content;
  details.append(summary, body);
  return details;
}

export function renderMessage(
  message: StoredMessage,
  labels: { user: string; assistant: string },
): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = `message message-${message.role}`;
  wrapper.dataset['messageId'] = String(message.id);

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const speaker = document.createElement('span');
  speaker.className = 'message-speaker';
  speaker.textContent = message.role === 'user' ? labels.user : labels.assistant;
  meta.append(speaker);
  if (message.interrupted) {
    const interrupted = document.createElement('span');
    interrupted.className = 'message-interrupted';
    interrupted.textContent = t('message.interrupted');
    meta.append(interrupted);
  }
  wrapper.append(meta);

  if (message.kind === 'notice') {
    const notice = document.createElement('div');
    notice.className = 'message-notice';
    const text = message.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as Extract<Block, { type: 'text' }>).text)
      .join('\n');
    notice.textContent = `[${t('message.notice')}] ${text}`;
    wrapper.append(notice);
    return wrapper;
  }

  if (message.kind === 'summary') {
    const details = document.createElement('details');
    details.className = 'message-summary';
    const summary = document.createElement('summary');
    summary.textContent = t('message.summary');
    const body = document.createElement('div');
    body.className = 'block-body';
    body.textContent = message.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as Extract<Block, { type: 'text' }>).text)
      .join('\n');
    details.append(summary, body);
    wrapper.append(details);
    return wrapper;
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  for (const block of message.blocks) {
    const node = blockElement(block);
    if (node !== null) content.append(node);
  }
  wrapper.append(content);
  return wrapper;
}
