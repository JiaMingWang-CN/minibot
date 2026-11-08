import type { Bot, KernelEvent, Revision, RevisionSource } from '@minibot/core';
import { t } from '../i18n/index.js';
import { ApiError, type Api } from '../api.js';
import type { View } from './onboarding.js';

interface MemoryFileInfo {
  path: string;
  name: string;
  summary: string | null;
  isUser: boolean;
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function sourceLabel(source: RevisionSource): string {
  if (source === 'chat') return t('memory.source.chat');
  if (source === 'consolidation') return t('memory.source.consolidation');
  if (source === 'manual_ui') return t('memory.source.manual_ui');
  if (source === 'revert') return t('memory.source.revert');
  return t('memory.source.external');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MemoryView implements View {
  private api: Api;
  private bot: Bot;
  private onBack: () => void;

  private root: HTMLElement | undefined;
  private fileList: HTMLElement | undefined;
  private pathLabel: HTMLElement | undefined;
  private editor: HTMLTextAreaElement | undefined;
  private status: HTMLElement | undefined;
  private revisionList: HTMLElement | undefined;

  private files: MemoryFileInfo[] = [];
  private activePath: string | null = null;
  private baseHash = '';
  private dirty = false;
  private loading = false;

  constructor(api: Api, bot: Bot, onBack: () => void) {
    this.api = api;
    this.bot = bot;
    this.onBack = onBack;
  }

  mount(el: HTMLElement): void {
    const page = div('page');
    const header = div('page-header');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'secondary small';
    back.textContent = t('common.back');
    back.addEventListener('click', () => this.onBack());
    const title = document.createElement('span');
    title.className = 'page-title';
    title.textContent = t('memory.title');
    header.append(back, title);

    const body = div('memory-body');
    const sidebar = div('memory-sidebar');
    const list = div('memory-file-list');
    this.fileList = list;
    sidebar.append(list);

    const editorPanel = div('memory-editor');
    const pathLabel = div('memory-path');
    this.pathLabel = pathLabel;
    const editor = document.createElement('textarea');
    editor.rows = 16;
    editor.addEventListener('input', () => {
      this.dirty = true;
    });
    this.editor = editor;
    const actions = div('memory-actions');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = t('memory.save');
    save.addEventListener('click', () => {
      void this.save();
    });
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'secondary';
    reload.textContent = t('memory.reload');
    reload.addEventListener('click', () => {
      if (this.activePath !== null) void this.openFile(this.activePath);
    });
    actions.append(save, reload);
    const status = div('status');
    this.status = status;
    editorPanel.append(pathLabel, editor, actions, status);

    const revisions = div('memory-revisions');
    const revTitle = div('section-title');
    revTitle.textContent = t('memory.revisions');
    const revList = div('revision-list');
    this.revisionList = revList;
    revisions.append(revTitle, revList);

    body.append(sidebar, editorPanel, revisions);
    page.append(header, body);
    el.replaceChildren(page);
    this.root = page;
    void this.loadList();
  }

  onEvent(event: KernelEvent): void {
    if (event.type !== 'memory_changed') return;
    if (event.path === this.activePath) {
      if (this.dirty) {
        if (this.status !== undefined) this.status.textContent = t('memory.conflict');
      } else {
        void this.openFile(event.path);
      }
    }
  }

  private async loadList(): Promise<void> {
    try {
      const memory = await this.api.listMemory(this.bot.id);
      this.files = [
        {
          path: memory.user.path,
          name: t('memory.userProfile'),
          summary: null,
          isUser: true,
        },
        ...memory.topics.map((topic) => ({
          path: topic.path,
          name: topic.name,
          summary: topic.summary,
          isUser: false,
        })),
      ];
      this.renderFileList();
      const initial = this.activePath ?? this.files[0]?.path;
      if (initial !== undefined) await this.openFile(initial);
    } catch (err) {
      this.showError(err);
    }
  }

  private renderFileList(): void {
    if (this.fileList === undefined) return;
    this.fileList.replaceChildren();
    const userItem = this.files.find((file) => file.isUser);
    if (userItem !== undefined) {
      this.fileList.append(this.fileButton(userItem));
    }
    const section = div('section-title');
    section.textContent = t('memory.topics');
    this.fileList.append(section);
    const topics = this.files.filter((file) => !file.isUser);
    if (topics.length === 0) {
      const empty = div('hint');
      empty.textContent = t('memory.emptyTopics');
      this.fileList.append(empty);
      return;
    }
    for (const topic of topics) this.fileList.append(this.fileButton(topic));
  }

  private fileButton(file: MemoryFileInfo): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memory-file';
    if (file.path === this.activePath) button.classList.add('is-active');
    const name = document.createElement('div');
    name.className = 'memory-file-name';
    name.textContent = file.name;
    const summary = document.createElement('div');
    summary.className = 'memory-file-summary';
    summary.textContent = file.isUser ? '' : (file.summary ?? t('memory.noSummary'));
    button.append(name, summary);
    button.addEventListener('click', () => {
      void this.openFile(file.path);
    });
    return button;
  }

  private async openFile(path: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const file = await this.api.readMemoryFile(path);
      this.activePath = path;
      this.baseHash = file.hash;
      this.dirty = false;
      if (this.editor !== undefined) this.editor.value = file.content;
      if (this.pathLabel !== undefined) {
        const info = this.files.find((item) => item.path === path);
        this.pathLabel.textContent = info?.name ?? path;
      }
      if (this.status !== undefined) this.status.textContent = '';
      this.renderFileList();
      await this.loadRevisions(path);
    } catch (err) {
      this.showError(err);
    } finally {
      this.loading = false;
    }
  }

  private async loadRevisions(path: string): Promise<void> {
    try {
      const revisions = await this.api.listRevisions(path);
      this.renderRevisions(revisions);
    } catch (err) {
      this.showError(err);
    }
  }

  private renderRevisions(revisions: Revision[]): void {
    if (this.revisionList === undefined) return;
    this.revisionList.replaceChildren();
    if (revisions.length === 0) {
      const empty = div('hint');
      empty.textContent = t('memory.noRevisions');
      this.revisionList.append(empty);
      return;
    }
    for (const revision of [...revisions].reverse()) {
      const row = div('revision-row');
      const meta = div('revision-meta');
      const source = document.createElement('span');
      source.className = 'revision-source';
      source.textContent = sourceLabel(revision.source);
      const actor = document.createElement('span');
      actor.textContent = revision.actor ?? t('memory.actorUnknown');
      const time = document.createElement('span');
      time.textContent = new Date(revision.createdAt).toLocaleString();
      meta.append(source, actor, time);
      const preview = document.createElement('div');
      preview.className = 'revision-preview';
      preview.textContent = revision.beforeContent.slice(0, 120).replace(/\n/g, ' ');
      const revert = document.createElement('button');
      revert.type = 'button';
      revert.className = 'secondary small';
      revert.textContent = t('memory.revert');
      revert.addEventListener('click', () => {
        void this.revert(revision.id);
      });
      row.append(meta, preview, revert);
      this.revisionList.append(row);
    }
  }

  private async save(): Promise<void> {
    if (this.activePath === null || this.editor === undefined) return;
    try {
      const result = await this.api.writeMemoryFile(
        this.activePath,
        this.editor.value,
        this.baseHash,
      );
      this.baseHash = result.hash;
      this.dirty = false;
      if (this.status !== undefined) this.status.textContent = t('memory.saved');
      await this.loadRevisions(this.activePath);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        if (this.status !== undefined) this.status.textContent = t('memory.conflict');
      } else {
        this.showError(err);
      }
    }
  }

  private async revert(revisionId: number): Promise<void> {
    try {
      await this.api.revert(revisionId);
      if (this.activePath !== null) await this.openFile(this.activePath);
      if (this.status !== undefined) this.status.textContent = t('memory.reverted');
    } catch (err) {
      this.showError(err);
    }
  }

  private showError(err: unknown): void {
    if (this.status !== undefined) {
      this.status.textContent = t('common.error', { message: messageOf(err) });
    }
  }
}
