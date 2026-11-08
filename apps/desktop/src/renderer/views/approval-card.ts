import type { ApprovalRequest } from '@minibot/core';
import { t } from '../i18n/index.js';

export class ApprovalCard {
  private element: HTMLElement;
  private status: HTMLElement;
  private approveButton: HTMLButtonElement;
  private denyButton: HTMLButtonElement;
  private resolved = false;

  constructor(request: ApprovalRequest, respond: (id: string, approve: boolean) => void) {
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.dataset['approvalId'] = request.id;

    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = t('approval.title');

    const tool = document.createElement('div');
    tool.className = 'approval-line';
    tool.textContent = t('approval.tool', { tool: request.tool });

    const summary = document.createElement('div');
    summary.className = 'approval-line';
    summary.textContent = t('approval.summary', { summary: request.summary });

    const status = document.createElement('div');
    status.className = 'approval-status';

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary';
    approve.textContent = t('approval.approve');
    approve.addEventListener('click', () => respond(request.id, true));
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'secondary';
    deny.textContent = t('approval.deny');
    deny.addEventListener('click', () => respond(request.id, false));
    actions.append(approve, deny);

    card.append(title, tool, summary, status, actions);
    this.element = card;
    this.status = status;
    this.approveButton = approve;
    this.denyButton = deny;
  }

  root(): HTMLElement {
    return this.element;
  }

  resolve(result: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.approveButton.disabled = true;
    this.denyButton.disabled = true;
    if (result === 'approved') this.status.textContent = t('approval.approved');
    else if (result === 'denied') this.status.textContent = t('approval.denied');
    else this.status.textContent = t('approval.cancelled');
    this.element.classList.add('is-resolved');
  }
}
