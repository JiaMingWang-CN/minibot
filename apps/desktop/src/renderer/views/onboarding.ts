import type { Bot, KernelState } from '@minibot/core';
import { t, type MessageKey } from '../i18n/index.js';
import type { Api, PresetWithModels } from '../api.js';
import { ApiError } from '../api.js';

export interface View {
  mount(el: HTMLElement): void;
  dispose?(): void;
  onEvent?(event: unknown): void;
}

interface Draft {
  profile: string;
  name: string;
  persona: string;
  workspace: string;
  model: string;
  contextWindow: number;
}

class UiError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function labeled(labelText: string, control: HTMLElement): HTMLDivElement {
  const field = div('field');
  const label = document.createElement('label');
  const text = document.createElement('span');
  text.className = 'field-label';
  text.textContent = labelText;
  label.append(text, control);
  field.append(label);
  return field;
}

function textInput(type: string, placeholder = ''): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  return input;
}

function formatName(format: string): string {
  if (format === 'chat_completions') return 'Chat Completions';
  if (format === 'responses') return 'Responses';
  return 'Anthropic Messages';
}

// Brand symbol; the cursor eye gets an overlay that can "blink" like a text caret.
const MARK_SVG =
  '<svg viewBox="36 56 184 144" aria-hidden="true">' +
  '<path fill-rule="evenodd" fill="#7c3aed" d="M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52ZM98 106a20 20 0 1 0 0 40a20 20 0 1 0 0 -40ZM142 128h46v18h-46Z"/>' +
  '<rect class="ob-caret" x="141" y="127" width="48" height="20" fill="#7c3aed" opacity="0"/>' +
  '</svg>';

interface StepInfo {
  title: MessageKey;
  intro: MessageKey;
  optional: boolean;
}

const STEPS: StepInfo[] = [
  { title: 'onboarding.step.model', intro: 'onboarding.model.intro', optional: false },
  { title: 'onboarding.step.profile', intro: 'onboarding.profile.intro', optional: true },
  { title: 'onboarding.step.bot', intro: 'onboarding.bot.intro', optional: true },
  { title: 'onboarding.step.workspace', intro: 'onboarding.workspace.intro', optional: true },
];

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const DURATION = 420;

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class OnboardingView implements View {
  private api: Api;
  private state: KernelState;
  private presets: PresetWithModels[];
  private onDone: (bot: Bot) => void;

  private mark: HTMLDivElement | undefined;
  private viewport: HTMLDivElement | undefined;
  private panels: HTMLDivElement[] = [];
  private stepItems: HTMLLIElement[] = [];
  private counter: HTMLDivElement | undefined;
  private backButton: HTMLButtonElement | undefined;
  private nextButton: HTMLButtonElement | undefined;
  private status: HTMLDivElement | undefined;
  private busy = false;
  private transition: Animation[] = [];

  private presetSelect: HTMLSelectElement | undefined;
  private providerNameInput: HTMLInputElement | undefined;
  private baseUrlInput: HTMLInputElement | undefined;
  private formatValue: HTMLSpanElement | undefined;
  private apiKeyInput: HTMLInputElement | undefined;
  private apiKeyEnvInput: HTMLInputElement | undefined;
  private modelInput: HTMLInputElement | undefined;
  private modelList: HTMLDataListElement | undefined;
  private contextWindowInput: HTMLInputElement | undefined;

  private profileInput: HTMLTextAreaElement | undefined;
  private botNameInput: HTMLInputElement | undefined;
  private botPersonaInput: HTMLTextAreaElement | undefined;
  private workspaceInput: HTMLInputElement | undefined;

  private step = 0;
  private providerId: string | null = null;
  private contextTouched = false;
  private draft: Draft = {
    profile: '',
    name: '',
    persona: '',
    workspace: '',
    model: '',
    contextWindow: 128000,
  };

  constructor(
    api: Api,
    state: KernelState,
    presets: PresetWithModels[],
    onDone: (bot: Bot) => void,
  ) {
    this.api = api;
    this.state = state;
    this.presets = presets;
    this.onDone = onDone;
  }

  mount(el: HTMLElement): void {
    const root = div('onboarding');
    const stage = div('ob-stage');

    const mark = div('ob-mark');
    mark.innerHTML = MARK_SVG;
    this.mark = mark;

    const steps = document.createElement('ol');
    steps.className = 'ob-steps';
    this.stepItems = STEPS.map((info) => {
      const li = document.createElement('li');
      li.className = 'ob-step';
      const bar = document.createElement('span');
      bar.className = 'ob-step-bar';
      const label = document.createElement('span');
      label.className = 'ob-step-label';
      label.textContent = t(info.title);
      li.append(bar, label);
      return li;
    });
    steps.append(...this.stepItems);

    const card = div('ob-card');
    const viewport = div('ob-viewport');
    this.viewport = viewport;
    this.panels = [
      this.buildModelStep(),
      this.buildProfileStep(),
      this.buildBotStep(),
      this.buildWorkspaceStep(),
    ];
    viewport.append(...this.panels);

    const status = div('status');
    status.setAttribute('role', 'status');
    this.status = status;

    const footer = div('ob-footer');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ghost';
    back.textContent = t('common.back');
    back.addEventListener('click', () => {
      if (this.step > 0 && !this.busy) {
        this.clearStatus();
        this.goTo(this.step - 1);
      }
    });
    this.backButton = back;
    const counter = div('ob-counter');
    this.counter = counter;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'primary';
    next.addEventListener('click', () => {
      void this.next();
    });
    this.nextButton = next;
    footer.append(back, counter, next);

    card.append(viewport, status, footer);

    const note = div('ob-note');
    note.textContent = t('onboarding.footnote');

    stage.append(mark, steps, card, note);
    root.append(stage);
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      void this.next();
    });
    el.replaceChildren(root);

    this.applyPreset();
    this.panels[0]?.classList.add('is-active');
    this.renderChrome();
    this.blink();
  }

  dispose(): void {
    for (const animation of this.transition) animation.cancel();
  }

  private selectedPreset(): PresetWithModels | undefined {
    if (this.presetSelect === undefined) return undefined;
    return this.presets.find((p) => p.id === this.presetSelect!.value);
  }

  private panel(index: number): HTMLDivElement {
    const info = STEPS[index]!;
    const panel = div('step-panel');
    const heading = div('ob-heading');
    const title = document.createElement('h1');
    title.className = 'ob-title';
    title.textContent = t(info.title);
    heading.append(title);
    if (info.optional) {
      const tag = document.createElement('span');
      tag.className = 'ob-tag';
      tag.textContent = t('onboarding.optional');
      heading.append(tag);
    }
    const intro = div('step-intro');
    intro.textContent = t(info.intro);
    panel.append(heading, intro);
    return panel;
  }

  private buildModelStep(): HTMLDivElement {
    const panel = this.panel(0);

    const preset = document.createElement('select');
    preset.id = 'provider-preset';
    for (const item of this.presets) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      preset.append(option);
    }
    preset.addEventListener('change', () => this.applyPreset());
    this.presetSelect = preset;
    const presetField = labeled(t('onboarding.model.preset'), preset);
    const meta = div('ob-meta');
    meta.append(t('onboarding.model.format'));
    const formatValue = document.createElement('span');
    formatValue.className = 'ob-pill';
    this.formatValue = formatValue;
    meta.append(formatValue);
    presetField.append(meta);

    const baseUrl = textInput('text', 'https://');
    baseUrl.id = 'provider-base-url';
    this.baseUrlInput = baseUrl;

    const model = textInput('text');
    model.id = 'provider-model';
    model.setAttribute('autocomplete', 'off');
    const list = document.createElement('datalist');
    list.id = 'minibot-model-list';
    this.modelList = list;
    model.setAttribute('list', list.id);
    model.addEventListener('input', () => {
      if (!this.contextTouched) this.updateContextWindow();
    });
    this.modelInput = model;

    const test = document.createElement('button');
    test.type = 'button';
    test.id = 'test-connection';
    test.className = 'secondary';
    test.textContent = t('onboarding.model.test');
    test.addEventListener('click', () => {
      void this.testConnection();
    });

    const keyRow = div('ob-inline');
    const keyChildren: HTMLElement[] = [];
    if (this.state.canPersistKeys) {
      const apiKey = textInput('password');
      apiKey.id = 'provider-api-key';
      apiKey.setAttribute('autocomplete', 'off');
      this.apiKeyInput = apiKey;
      keyRow.append(labeled(t('onboarding.model.apiKey'), apiKey), test);
    } else {
      const hint = div('hint');
      hint.textContent = t('onboarding.model.keyPersistHint');
      keyChildren.push(hint);
      const env = textInput('text', 'MINIBOT_API_KEY');
      env.id = 'provider-api-key-env';
      this.apiKeyEnvInput = env;
      keyRow.append(labeled(t('onboarding.model.apiKeyEnv'), env), test);
    }
    keyChildren.push(keyRow);

    // Rarely-changed values live behind a disclosure to keep the required step short.
    const more = document.createElement('details');
    more.className = 'ob-more';
    const summary = document.createElement('summary');
    summary.textContent = t('onboarding.model.more');
    const name = textInput('text');
    name.id = 'provider-name';
    this.providerNameInput = name;
    const contextWindow = textInput('number');
    contextWindow.id = 'provider-context-window';
    contextWindow.min = '1';
    contextWindow.addEventListener('input', () => {
      this.contextTouched = true;
    });
    this.contextWindowInput = contextWindow;
    const moreRow = div('ob-row');
    moreRow.append(
      labeled(t('onboarding.model.providerName'), name),
      labeled(t('onboarding.model.contextWindow'), contextWindow),
    );
    more.append(summary, moreRow);

    panel.append(
      presetField,
      labeled(t('onboarding.model.baseUrl'), baseUrl),
      labeled(t('onboarding.model.modelName'), model),
      list,
      ...keyChildren,
      more,
    );
    return panel;
  }

  private buildProfileStep(): HTMLDivElement {
    const panel = this.panel(1);
    const textarea = document.createElement('textarea');
    textarea.id = 'profile';
    textarea.rows = 7;
    textarea.placeholder = t('onboarding.profile.placeholder');
    this.profileInput = textarea;
    panel.append(labeled(t('onboarding.profile.label'), textarea));
    return panel;
  }

  private buildBotStep(): HTMLDivElement {
    const panel = this.panel(2);
    const name = textInput('text', t('onboarding.bot.namePlaceholder'));
    name.id = 'bot-name';
    this.botNameInput = name;
    const persona = document.createElement('textarea');
    persona.id = 'bot-persona';
    persona.rows = 4;
    persona.placeholder = t('onboarding.bot.personaPlaceholder');
    this.botPersonaInput = persona;
    panel.append(
      labeled(t('onboarding.bot.name'), name),
      labeled(t('onboarding.bot.persona'), persona),
    );
    return panel;
  }

  private buildWorkspaceStep(): HTMLDivElement {
    const panel = this.panel(3);
    const workspace = textInput('text', t('onboarding.workspace.placeholder'));
    workspace.id = 'bot-workspace';
    this.workspaceInput = workspace;
    panel.append(labeled(t('onboarding.workspace.label'), workspace));
    return panel;
  }

  private applyPreset(): void {
    const preset = this.selectedPreset();
    if (preset === undefined) return;
    if (this.providerNameInput !== undefined) this.providerNameInput.value = preset.name;
    if (this.baseUrlInput !== undefined) this.baseUrlInput.value = preset.baseUrl;
    if (this.formatValue !== undefined) this.formatValue.textContent = formatName(preset.format);
    if (this.modelList !== undefined) {
      this.modelList.replaceChildren(
        ...preset.models.map((model) => {
          const option = document.createElement('option');
          option.value = model.id;
          return option;
        }),
      );
    }
    this.contextTouched = false;
    this.updateContextWindow();
  }

  private updateContextWindow(): void {
    const preset = this.selectedPreset();
    if (preset === undefined) return;
    const entered = this.modelInput?.value.trim().toLowerCase() ?? '';
    const known = preset.models.find((model) => model.id.toLowerCase() === entered);
    if (this.contextWindowInput !== undefined) {
      this.contextWindowInput.value = String(known?.contextWindow ?? preset.contextWindow);
    }
  }

  /** Stepper, counter and footer buttons. */
  private renderChrome(): void {
    const total = this.panels.length;
    this.stepItems.forEach((item, index) => {
      item.classList.toggle('is-done', index < this.step);
      item.classList.toggle('is-current', index === this.step);
      if (index === this.step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    if (this.counter !== undefined) {
      this.counter.textContent = t('onboarding.step.progress', { current: this.step + 1, total });
    }
    if (this.backButton !== undefined) this.backButton.style.visibility = this.step > 0 ? 'visible' : 'hidden';
    if (this.nextButton !== undefined) {
      this.nextButton.textContent = this.step === total - 1 ? t('onboarding.finish') : t('common.next');
    }
  }

  /** The logo's cursor eye blinks twice, like a caret waiting for input. */
  private blink(): void {
    const caret = this.mark?.querySelector('.ob-caret');
    if (caret === null || caret === undefined || reducedMotion()) return;
    caret.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }, { opacity: 0 }], {
      duration: 900,
      easing: 'steps(1, end)',
    });
  }

  /** Slide the current panel out and the target panel in, animating the card height between them. */
  private goTo(target: number): void {
    const viewport = this.viewport;
    const from = this.panels[this.step];
    const to = this.panels[target];
    if (viewport === undefined || from === undefined || to === undefined || target === this.step) return;
    const direction = target > this.step ? 1 : -1;
    this.step = target;
    this.renderChrome();
    this.blink();

    for (const animation of this.transition) animation.cancel();
    this.transition = [];
    for (const panel of this.panels) {
      if (panel !== from && panel !== to) panel.classList.remove('is-active', 'is-leaving');
    }

    const focusFirst = (): void => {
      const field = to.querySelector<HTMLElement>('input, textarea, select');
      field?.focus({ preventScroll: true });
    };

    if (reducedMotion()) {
      from.classList.remove('is-active', 'is-leaving');
      to.classList.add('is-active');
      focusFirst();
      return;
    }

    const startHeight = viewport.offsetHeight;
    from.classList.add('is-leaving');
    to.classList.add('is-active');
    to.classList.remove('is-leaving');
    const endHeight = to.offsetHeight;

    const shift = 56 * direction;
    const leave = from.animate(
      [
        { transform: 'translateX(0)', opacity: 1, filter: 'blur(0)' },
        { transform: `translateX(${-shift}px)`, opacity: 0, filter: 'blur(2px)' },
      ],
      { duration: DURATION * 0.7, easing: EASE, fill: 'forwards' },
    );
    const enter = to.animate(
      [
        { transform: `translateX(${shift}px)`, opacity: 0 },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      { duration: DURATION, easing: EASE, delay: DURATION * 0.12, fill: 'backwards' },
    );
    const resize = viewport.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], {
      duration: DURATION,
      easing: EASE,
    });
    const current = [leave, enter, resize];
    this.transition = current;

    void Promise.all(current.map((animation) => animation.finished))
      .then(() => {
        from.classList.remove('is-active', 'is-leaving');
        leave.cancel();
        if (this.transition === current) this.transition = [];
        focusFirst();
      })
      .catch(() => {
        // Superseded by a newer transition.
      });
  }

  private clearStatus(): void {
    if (this.status === undefined) return;
    this.status.textContent = '';
    this.status.classList.remove('is-error', 'is-success');
  }

  private showStatus(text: string, isError: boolean): void {
    if (this.status === undefined) return;
    this.status.textContent = text;
    this.status.classList.toggle('is-error', isError);
    this.status.classList.toggle('is-success', !isError);
    this.status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private requireModel(): string {
    const model = this.modelInput?.value.trim() ?? '';
    if (model.length === 0) throw new UiError(t('onboarding.error.modelRequired'));
    return model;
  }

  private async ensureProvider(): Promise<string> {
    const preset = this.selectedPreset();
    if (preset === undefined) throw new UiError(t('onboarding.model.requiredHint'));
    const baseUrl = this.baseUrlInput?.value.trim() ?? '';
    if (baseUrl.length === 0) throw new UiError(t('onboarding.error.baseUrlRequired'));
    const input = {
      name: this.providerNameInput?.value.trim() || preset.name,
      format: preset.format,
      baseUrl,
      presetId: preset.id,
    } as {
      name: string;
      format: PresetWithModels['format'];
      baseUrl: string;
      presetId: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };

    if (this.state.canPersistKeys) {
      const apiKey = this.apiKeyInput?.value.trim() ?? '';
      if (this.providerId === null && apiKey.length === 0) {
        throw new UiError(t('onboarding.error.apiKeyRequired'));
      }
      if (apiKey.length > 0) input.apiKey = apiKey;
    } else {
      const env = this.apiKeyEnvInput?.value.trim() ?? '';
      if (env.length === 0) throw new UiError(t('onboarding.error.apiKeyEnvRequired'));
      input.apiKeyEnv = env;
    }

    if (this.providerId !== null) {
      await this.api.updateProvider(this.providerId, input);
      return this.providerId;
    }
    const provider = await this.api.addProvider(input);
    this.providerId = provider.id;
    return provider.id;
  }

  private async testConnection(): Promise<void> {
    this.clearStatus();
    try {
      const model = this.requireModel();
      const providerId = await this.ensureProvider();
      this.showStatus(t('onboarding.model.testing'), false);
      const result = await this.api.testProvider(providerId, model);
      if (result.ok) {
        this.showStatus(t('onboarding.model.testOk'), false);
      } else if (result.kind === 'auth') {
        this.showStatus(t('onboarding.model.testAuth'), true);
      } else if (result.kind === 'url') {
        this.showStatus(t('onboarding.model.testUrl'), true);
      } else if (result.kind === 'network') {
        this.showStatus(t('onboarding.model.testNetwork'), true);
      } else {
        this.showStatus(t('onboarding.model.testOther', { message: result.message }), true);
      }
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : messageOf(err);
      this.showStatus(t('onboarding.error.provider', { message }), true);
    }
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.nextButton !== undefined) this.nextButton.disabled = true;
    this.clearStatus();
    try {
      if (this.step === 0) {
        const model = this.requireModel();
        const contextWindow = Number(this.contextWindowInput?.value ?? '');
        this.draft.model = model;
        this.draft.contextWindow =
          Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
        await this.ensureProvider();
        this.goTo(1);
      } else if (this.step === 1) {
        this.draft.profile = this.profileInput?.value.trim() ?? '';
        this.goTo(2);
      } else if (this.step === 2) {
        this.draft.name = this.botNameInput?.value.trim() ?? '';
        this.draft.persona = this.botPersonaInput?.value.trim() ?? '';
        this.goTo(3);
      } else {
        await this.finish();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : messageOf(err);
      this.showStatus(message, true);
    } finally {
      this.busy = false;
      if (this.nextButton !== undefined) this.nextButton.disabled = false;
    }
  }

  private async finish(): Promise<void> {
    this.draft.workspace = this.workspaceInput?.value.trim() ?? '';
    if (this.providerId === null) throw new UiError(t('onboarding.model.requiredHint'));
    this.showStatus(t('onboarding.finishing'), false);
    const input: Parameters<Api['completeOnboarding']>[0] = {
      providerId: this.providerId,
      model: this.draft.model,
      contextWindow: this.draft.contextWindow,
    };
    if (this.draft.profile.length > 0) input.profile = this.draft.profile;
    if (this.draft.name.length > 0) input.name = this.draft.name;
    if (this.draft.persona.length > 0) input.persona = this.draft.persona;
    if (this.draft.workspace.length > 0) input.workspace = this.draft.workspace;
    const bot = await this.api.completeOnboarding(input);
    this.onDone(bot);
  }
}
