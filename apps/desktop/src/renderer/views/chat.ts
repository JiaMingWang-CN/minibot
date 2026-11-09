import type { ApprovalRequest, Bot, KernelEvent, StoredMessage, Thread } from '@minibot/core';
import { t } from '../i18n/index.js';
import type { Api, ClientMessage } from '../api.js';
import { renderMessage } from './message.js';
import { ApprovalCard } from './approval-card.js';
import type { View } from './onboarding.js';

const PAGE_SIZE = 30;
const OLDER_SIZE = 20;

const BOT_PATH =
  'M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52ZM98 106a20 20 0 1 0 0 40a20 20 0 1 0 0 -40ZM142 128h46v18h-46Z';
const MARK_SVG = `<svg viewBox="36 56 184 144" aria-hidden="true"><path fill-rule="evenodd" fill="#7c3aed" d="${BOT_PATH}"/></svg>`;
const LOGO_SVG =
  '<svg viewBox="-24 0 968.444 256" role="img" aria-label="minibot">' +
  `<path transform="translate(-40 -14.2222) scale(1.11111)" fill-rule="evenodd" fill="#7c3aed" d="${BOT_PATH}"/>` +
  '<path transform="translate(264.444 208) scale(1)" fill="#1c1917" d="M0 0V-59.5A42 42 0 0 1 84 -59.5V0H62V-59.5A20 20 0 0 0 22 -59.5V0ZM62 0V-59.5A42 42 0 0 1 146 -59.5V0H124V-59.5A20 20 0 0 0 84 -59.5V0ZM170 -100H192V0H170ZM181 -143A13 13 0 1 1 181 -117A13 13 0 1 1 181 -143ZM216 0V-59.5A42 42 0 0 1 300 -59.5V0H278V-59.5A20 20 0 0 0 238 -59.5V0ZM324 -100H346V0H324ZM335 -143A13 13 0 1 1 335 -117A13 13 0 1 1 335 -143ZM370 -140H392V0H370ZM421.5 -101.5A51.5 51.5 0 1 1 421.5 1.5A51.5 51.5 0 1 1 421.5 -101.5ZM421.5 -79.5A29.5 29.5 0 1 0 421.5 -20.5A29.5 29.5 0 1 0 421.5 -79.5ZM538.5 -101.5A51.5 51.5 0 1 1 538.5 1.5A51.5 51.5 0 1 1 538.5 -101.5ZM538.5 -79.5A29.5 29.5 0 1 0 538.5 -20.5A29.5 29.5 0 1 0 538.5 -79.5ZM614 -128H636V0H614ZM600 -100H656V-78H600Z"/>' +
  '</svg>';

function icon(paths: string, className = ''): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICON_PLUS = icon('<path d="M12 5v14M5 12h14"/>');
const ICON_MEMORY = icon('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>');
const ICON_SETTINGS = icon(
  '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
);
const ICON_SEND = icon('<path d="M12 19V5M6 11l6-6 6 6"/>', 'icon-send');
const ICON_STOP =
  '<svg class="icon-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';

function iconButton(svg: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.innerHTML = svg;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ChatViewOptions {
  onOpenMemory?: () => void;
  onOpenSettings?: () => void;
}

export class ChatView implements View {
  private api: Api;
  private bot: Bot;
  private send: (message: ClientMessage) => void;
  private options: ChatViewOptions;

  private layout: HTMLElement | undefined;
  private threadList: HTMLElement | undefined;
  private messageList: HTMLElement | undefined;
  private input: HTMLTextAreaElement | undefined;
  private status: HTMLElement | undefined;
  private approvalArea: HTMLElement | undefined;
  private chatTitle: HTMLElement | undefined;
  private compactButton: HTMLButtonElement | undefined;
  private sendButton: HTMLButtonElement | undefined;

  private threads: Thread[] = [];
  private activeThreadId: string | null = null;
  private running = new Set<string>();
  private renderedIds = new Set<number>();
  private oldestId: number | null = null;
  private hasMore = true;
  private loadingOlder = false;
  private loadToken = 0;

  private streamElement: HTMLElement | undefined;
  private streamContent: HTMLElement | undefined;
  private approvals = new Map<string, ApprovalCard>();

  constructor(
    api: Api,
    bot: Bot,
    send: (message: ClientMessage) => void,
    options: ChatViewOptions = {},
  ) {
    this.api = api;
    this.bot = bot;
    this.send = send;
    this.options = options;
  }

  mount(el: HTMLElement): void {
    this.layout = div('chat-layout');

    const sidebar = div('thread-sidebar');
    const brand = div('side-brand');
    brand.innerHTML = LOGO_SVG;
    const newThread = document.createElement('button');
    newThread.type = 'button';
    newThread.className = 'new-thread';
    newThread.innerHTML = ICON_PLUS;
    newThread.append(t('chat.newThread'));
    newThread.addEventListener('click', () => {
      void this.createThread();
    });
    const threadList = div('thread-list');
    this.threadList = threadList;

    const foot = div('side-foot');
    const avatar = div('bot-avatar');
    avatar.innerHTML = MARK_SVG;
    const botName = document.createElement('span');
    botName.className = 'bot-name';
    botName.textContent = this.bot.name;
    foot.append(avatar, botName);
    if (this.options.onOpenMemory !== undefined) {
      const memory = iconButton(ICON_MEMORY, t('chat.memory'));
      memory.addEventListener('click', () => this.options.onOpenMemory?.());
      foot.append(memory);
    }
    if (this.options.onOpenSettings !== undefined) {
      const settings = iconButton(ICON_SETTINGS, t('chat.settings'));
      settings.addEventListener('click', () => this.options.onOpenSettings?.());
      foot.append(settings);
    }
    sidebar.append(brand, newThread, threadList, foot);

    const main = div('chat-main');
    const header = div('chat-header');
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = t('chat.title');
    this.chatTitle = title;
    const actions = div('chat-actions');
    const compact = document.createElement('button');
    compact.type = 'button';
    compact.textContent = t('chat.compact');
    compact.addEventListener('click', () => {
      void this.compact();
    });
    actions.append(compact);
    header.append(title, actions);
    this.compactButton = compact;

    const status = div('chat-status');
    status.setAttribute('role', 'status');
    this.status = status;

    const approvalArea = div('approval-area');
    this.approvalArea = approvalArea;

    const messageList = div('message-list');
    this.messageList = messageList;
    messageList.addEventListener('scroll', () => {
      if (messageList.scrollTop <= 2 && this.hasMore && !this.loadingOlder) {
        void this.loadOlder();
      }
    });

    const composer = div('composer');
    const box = div('composer-box');
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = t('chat.inputPlaceholder', { name: this.bot.name });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });
    input.addEventListener('input', () => this.fitInput());
    const bar = div('composer-bar');
    const hint = document.createElement('span');
    hint.className = 'composer-hint';
    hint.textContent = t('chat.inputHint');
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'send-button';
    sendButton.innerHTML = ICON_SEND + ICON_STOP;
    sendButton.addEventListener('click', () => {
      if (this.isActiveRunning()) {
        if (this.activeThreadId !== null) this.send({ type: 'abort', threadId: this.activeThreadId });
        return;
      }
      void this.submit();
    });
    bar.append(hint, sendButton);
    box.append(input, bar);
    composer.append(box);
    this.input = input;
    this.sendButton = sendButton;

    main.append(header, status, messageList, approvalArea, composer);
    this.layout.append(sidebar, main);
    el.replaceChildren(this.layout);
    this.updateButtons();
    void this.init();
  }

  onEvent(event: KernelEvent): void {
    if (event.type === 'approval_request') {
      this.addApproval(event.request);
      return;
    }
    if (event.type === 'approval_resolved') {
      this.resolveApproval(event.id, event.result);
      return;
    }
    if (event.type === 'turn') {
      if (event.state === 'running') this.running.add(event.threadId);
      else this.running.delete(event.threadId);
      this.renderThreads();
      if (event.threadId === this.activeThreadId && event.state === 'idle') this.clearStream();
      return;
    }
    if (!('threadId' in event)) return;
    if (event.threadId !== this.activeThreadId) return;
    if (event.type === 'delta') {
      this.appendDelta(event.delta.text);
      return;
    }
    if (event.type === 'message') {
      if (event.message.role === 'assistant') this.clearStream();
      this.appendMessage(event.message);
      if (event.message.role === 'assistant' && this.messageList !== undefined) {
        this.scrollToBottom();
      }
    }
  }

  private async init(): Promise<void> {
    try {
      this.threads = await this.api.listThreads(this.bot.id);
      if (this.threads.length === 0) {
        const thread = await this.api.createThread(this.bot.id);
        this.threads = [thread];
      }
      const first = this.threads[0];
      this.activeThreadId = first?.id ?? null;
      this.renderThreads();
      if (this.activeThreadId !== null) await this.loadMessages(this.activeThreadId);
      const pending = await this.api.pendingApprovals();
      for (const request of pending) this.addApproval(request);
    } catch (err) {
      this.showError(err);
    }
  }

  private async createThread(): Promise<void> {
    try {
      const thread = await this.api.createThread(this.bot.id);
      this.threads = [thread, ...this.threads];
      this.activeThreadId = thread.id;
      this.renderThreads();
      await this.loadMessages(thread.id);
    } catch (err) {
      this.showError(err);
    }
  }

  private async selectThread(threadId: string): Promise<void> {
    if (this.activeThreadId === threadId) return;
    this.activeThreadId = threadId;
    this.renderThreads();
    await this.loadMessages(threadId);
  }

  private renderThreads(): void {
    if (this.threadList === undefined) return;
    this.threadList.replaceChildren();
    for (const thread of this.threads) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'thread-item';
      if (thread.id === this.activeThreadId) item.classList.add('is-active');
      const title = document.createElement('span');
      title.className = 'thread-title';
      title.textContent = thread.title;
      const running = document.createElement('span');
      running.className = 'thread-running-dot';
      running.title = t('thread.running');
      running.setAttribute('aria-label', t('thread.running'));
      if (this.running.has(thread.id)) running.classList.add('is-visible');
      item.append(title, running);
      item.addEventListener('click', () => {
        void this.selectThread(thread.id);
      });
      this.threadList.append(item);
    }
    if (this.chatTitle !== undefined) {
      const active = this.threads.find((thread) => thread.id === this.activeThreadId);
      this.chatTitle.textContent = active?.title || t('chat.title');
    }
    this.updateButtons();
  }

  private isActiveRunning(): boolean {
    return this.activeThreadId !== null && this.running.has(this.activeThreadId);
  }

  private updateButtons(): void {
    const disabled = this.activeThreadId === null;
    if (this.compactButton !== undefined) this.compactButton.disabled = disabled;
    if (this.sendButton !== undefined) {
      const stop = this.isActiveRunning();
      this.sendButton.disabled = disabled;
      this.sendButton.classList.toggle('is-stop', stop);
      const label = stop ? t('chat.stop') : t('chat.send');
      this.sendButton.title = label;
      this.sendButton.setAttribute('aria-label', label);
    }
  }

  private fitInput(): void {
    if (this.input === undefined) return;
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight}px`;
  }

  private async loadMessages(threadId: string): Promise<void> {
    this.loadToken += 1;
    const token = this.loadToken;
    this.clearStream();
    if (this.messageList === undefined) return;
    this.messageList.replaceChildren();
    this.renderedIds.clear();
    this.oldestId = null;
    this.hasMore = true;
    try {
      const messages = await this.api.listMessages(threadId, undefined, PAGE_SIZE);
      if (token !== this.loadToken) return;
      if (messages.length === 0) {
        const empty = div('chat-empty');
        empty.innerHTML = MARK_SVG;
        const title = div('chat-empty-title');
        title.textContent = t('chat.emptyMessages', { name: this.bot.name });
        const hint = div('chat-empty-hint');
        hint.textContent = t('chat.emptyHint');
        empty.append(title, hint);
        this.messageList.append(empty);
      }
      this.hasMore = messages.length === PAGE_SIZE;
      for (const message of messages) this.appendMessage(message);
      this.scrollToBottom();
    } catch (err) {
      this.showError(err);
    }
  }

  private async loadOlder(): Promise<void> {
    if (this.loadingOlder || this.oldestId === null || this.activeThreadId === null) return;
    if (this.messageList === undefined) return;
    this.loadingOlder = true;
    const previousHeight = this.messageList.scrollHeight;
    try {
      const messages = await this.api.listMessages(this.activeThreadId, this.oldestId, OLDER_SIZE);
      if (messages.length < OLDER_SIZE) this.hasMore = false;
      const fragment = document.createDocumentFragment();
      for (const message of messages) {
        if (this.renderedIds.has(message.id)) continue;
        this.renderedIds.add(message.id);
        fragment.append(
          renderMessage(message, { user: t('chat.you'), assistant: this.bot.name }),
        );
      }
      if (fragment.childNodes.length > 0) {
        this.messageList.insertBefore(fragment, this.messageList.firstChild);
        this.messageList.scrollTop += this.messageList.scrollHeight - previousHeight;
      }
      if (messages.length > 0 && messages[0] !== undefined) {
        this.oldestId = messages[0].id;
      }
    } catch (err) {
      this.showError(err);
    } finally {
      this.loadingOlder = false;
    }
  }

  private appendMessage(message: StoredMessage): void {
    if (this.messageList === undefined || this.renderedIds.has(message.id)) return;
    const empty = this.messageList.querySelector('.chat-empty');
    if (empty !== null) empty.remove();
    this.renderedIds.add(message.id);
    if (this.oldestId === null) this.oldestId = message.id;
    this.messageList.append(
      renderMessage(message, { user: t('chat.you'), assistant: this.bot.name }),
    );
  }

  private appendDelta(text: string): void {
    if (this.messageList === undefined) return;
    if (this.streamElement === undefined) {
      const article = document.createElement('article');
      article.className = 'message message-assistant is-streaming';
      const meta = div('message-meta');
      const speaker = document.createElement('span');
      speaker.className = 'message-speaker';
      speaker.textContent = this.bot.name;
      meta.append(speaker);
      const content = div('message-content');
      const text = div('block-text');
      content.append(text);
      article.append(meta, content);
      this.messageList.querySelector('.chat-empty')?.remove();
      this.messageList.append(article);
      this.streamElement = article;
      this.streamContent = text;
    }
    if (this.streamContent !== undefined) this.streamContent.textContent += text;
    this.scrollToBottom();
  }

  private clearStream(): void {
    if (this.streamElement !== undefined) this.streamElement.remove();
    this.streamElement = undefined;
    this.streamContent = undefined;
  }

  private scrollToBottom(): void {
    if (this.messageList === undefined) return;
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  private showError(err: unknown): void {
    if (this.status !== undefined) {
      this.status.textContent = t('common.error', { message: messageOf(err) });
    }
  }

  private async submit(): Promise<void> {
    const text = this.input?.value.trim() ?? '';
    if (text.length === 0 || this.activeThreadId === null) return;
    const threadId = this.activeThreadId;
    try {
      await this.api.sendMessage(threadId, text);
      if (this.input !== undefined) this.input.value = '';
      this.fitInput();
      if (this.status !== undefined) this.status.textContent = '';
      this.scrollToBottom();
    } catch (err) {
      this.showError(err);
    }
  }

  private async compact(): Promise<void> {
    if (this.activeThreadId === null) return;
    try {
      await this.api.compact(this.activeThreadId);
      if (this.status !== undefined) this.status.textContent = t('chat.compacting');
    } catch (err) {
      this.showError(err);
    }
  }

  private addApproval(request: ApprovalRequest): void {
    if (this.approvalArea === undefined || this.approvals.has(request.id)) return;
    const card = new ApprovalCard(request, (id, approve) => {
      this.send({ type: 'approval', id, approve });
    });
    this.approvals.set(request.id, card);
    this.approvalArea.append(card.root());
  }

  private resolveApproval(id: string, result: string): void {
    this.approvals.get(id)?.resolve(result);
  }
}
