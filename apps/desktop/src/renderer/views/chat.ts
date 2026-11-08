import type { ApprovalRequest, Bot, KernelEvent, StoredMessage, Thread } from '@minibot/core';
import { t } from '../i18n/index.js';
import type { Api, ClientMessage } from '../api.js';
import { renderMessage } from './message.js';
import { ApprovalCard } from './approval-card.js';
import type { View } from './onboarding.js';

const PAGE_SIZE = 30;
const OLDER_SIZE = 20;

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
  private stopButton: HTMLButtonElement | undefined;
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
    const sidebarHead = div('thread-sidebar-head');
    const botName = document.createElement('span');
    botName.className = 'bot-name';
    botName.textContent = this.bot.name;
    const newThread = document.createElement('button');
    newThread.type = 'button';
    newThread.className = 'secondary small';
    newThread.textContent = t('chat.newThread');
    newThread.addEventListener('click', () => {
      void this.createThread();
    });
    sidebarHead.append(botName, newThread);
    const nav = div('thread-nav');
    if (this.options.onOpenMemory !== undefined) {
      const memory = document.createElement('button');
      memory.type = 'button';
      memory.className = 'secondary small';
      memory.textContent = t('chat.memory');
      memory.addEventListener('click', () => this.options.onOpenMemory?.());
      nav.append(memory);
    }
    if (this.options.onOpenSettings !== undefined) {
      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'secondary small';
      settings.textContent = t('chat.settings');
      settings.addEventListener('click', () => this.options.onOpenSettings?.());
      nav.append(settings);
    }
    const threadList = div('thread-list');
    this.threadList = threadList;
    sidebar.append(sidebarHead, nav, threadList);

    const main = div('chat-main');
    const header = div('chat-header');
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = t('chat.title');
    const actions = div('chat-actions');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'secondary small';
    stop.textContent = t('chat.stop');
    stop.addEventListener('click', () => {
      if (this.activeThreadId !== null) {
        this.send({ type: 'abort', threadId: this.activeThreadId });
      }
    });
    const compact = document.createElement('button');
    compact.type = 'button';
    compact.className = 'secondary small';
    compact.textContent = t('chat.compact');
    compact.addEventListener('click', () => {
      void this.compact();
    });
    actions.append(stop, compact);
    header.append(title, actions);
    this.stopButton = stop;
    this.compactButton = compact;

    const status = div('chat-status');
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
    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = t('chat.inputPlaceholder');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'primary';
    sendButton.textContent = t('chat.send');
    sendButton.addEventListener('click', () => {
      void this.submit();
    });
    composer.append(input, sendButton);
    this.input = input;
    this.sendButton = sendButton;

    main.append(header, status, approvalArea, messageList, composer);
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
      running.textContent = t('thread.running');
      if (this.running.has(thread.id)) running.classList.add('is-visible');
      item.append(title, running);
      item.addEventListener('click', () => {
        void this.selectThread(thread.id);
      });
      this.threadList.append(item);
    }
    this.updateButtons();
  }

  private updateButtons(): void {
    const disabled = this.activeThreadId === null;
    if (this.stopButton !== undefined) this.stopButton.disabled = disabled;
    if (this.compactButton !== undefined) this.compactButton.disabled = disabled;
    if (this.sendButton !== undefined) this.sendButton.disabled = disabled;
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
        empty.textContent = t('chat.emptyMessages');
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
      article.append(meta, content);
      this.messageList.append(article);
      this.streamElement = article;
      this.streamContent = content;
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
