import type { Bot, KernelState } from '@minibot/core';
import { t } from '../i18n/index.js';
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
  label.textContent = labelText;
  label.append(control);
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

export class OnboardingView implements View {
  private api: Api;
  private state: KernelState;
  private presets: PresetWithModels[];
  private onDone: (bot: Bot) => void;

  private root: HTMLDivElement | undefined;
  private card: HTMLDivElement | undefined;
  private panels: HTMLDivElement[] = [];
  private stepTitle: HTMLDivElement | undefined;
  private progress: HTMLDivElement | undefined;
  private backButton: HTMLButtonElement | undefined;
  private nextButton: HTMLButtonElement | undefined;
  private status: HTMLDivElement | undefined;

  private presetSelect: HTMLSelectElement | undefined;
  private providerNameInput: HTMLInputElement | undefined;
  private baseUrlInput: HTMLInputElement | undefined;
  private formatValue: HTMLSpanElement | undefined;
  private apiKeyInput: HTMLInputElement | undefined;
  private apiKeyEnvInput: HTMLInputElement | undefined;
  private modelInput: HTMLInputElement | undefined;
  private modelList: HTMLDataListElement | undefined;
  private contextWindowInput: HTMLInputElement | undefined;
  private testButton: HTMLButtonElement | undefined;

  private profileInput: HTMLTextAreaElement | undefined;
  private botNameInput: HTMLInputElement | undefined;
  private botPersonaInput: HTMLInputElement | undefined;
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
    const mascot = div('mascot');
    mascot.setAttribute('aria-label', t('onboarding.mascotAlt'));
    mascot.innerHTML =
      '<svg viewBox="36 56 184 144" role="img" aria-hidden="true">' +
      '<path fill-rule="evenodd" fill="#7c3aed" d="M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52ZM98 106a20 20 0 1 0 0 40a20 20 0 1 0 0 -40ZM142 128h46v18h-46Z"/>' +
      '</svg>';

    const card = div('onboarding-card');
    this.card = card;
    const title = div('onboarding-title');
    title.textContent = t('onboarding.title');
    const progress = div('onboarding-progress');
    this.progress = progress;
    const stepTitle = div('onboarding-step-title');
    this.stepTitle = stepTitle;

    const panels = div('step-panels');
    this.panels = [
      this.buildModelStep(),
      this.buildProfileStep(),
      this.buildBotStep(),
      this.buildWorkspaceStep(),
    ];
    panels.append(...this.panels);

    const status = div('status');
    this.status = status;

    const actions = div('onboarding-actions');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'secondary';
    back.textContent = t('common.back');
    back.addEventListener('click', () => {
      if (this.step > 0) {
        this.step -= 1;
        this.clearStatus();
        this.renderStep();
      }
    });
    this.backButton = back;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'primary';
    next.addEventListener('click', () => {
      void this.next();
    });
    this.nextButton = next;
    actions.append(back, next);

    card.append(title, progress, stepTitle, panels, status, actions);
    root.append(mascot, card);
    el.replaceChildren(root);
    this.root = root;

    this.applyPreset();
    this.renderStep();
  }

  private selectedPreset(): PresetWithModels | undefined {
    if (this.presetSelect === undefined) return undefined;
    return this.presets.find((p) => p.id === this.presetSelect!.value);
  }

  private buildModelStep(): HTMLDivElement {
    const panel = div('step-panel');

    const intro = div('step-intro');
    intro.textContent = t('onboarding.model.intro');
    panel.append(intro);

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
    panel.append(labeled(t('onboarding.model.preset'), preset));

    const name = textInput('text');
    name.id = 'provider-name';
    this.providerNameInput = name;
    panel.append(labeled(t('onboarding.model.providerName'), name));

    const baseUrl = textInput('text', 'https://');
    baseUrl.id = 'provider-base-url';
    this.baseUrlInput = baseUrl;
    panel.append(labeled(t('onboarding.model.baseUrl'), baseUrl));

    const formatRow = div('field');
    const formatLabel = document.createElement('label');
    formatLabel.textContent = t('onboarding.model.format');
    const formatValue = document.createElement('span');
    formatValue.className = 'readonly-value';
    this.formatValue = formatValue;
    formatLabel.append(formatValue);
    formatRow.append(formatLabel);
    panel.append(formatRow);

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
    panel.append(labeled(t('onboarding.model.modelName'), model), list);

    if (this.state.canPersistKeys) {
      const apiKey = textInput('password');
      apiKey.id = 'provider-api-key';
      this.apiKeyInput = apiKey;
      panel.append(labeled(t('onboarding.model.apiKey'), apiKey));
    } else {
      const hint = div('hint');
      hint.textContent = t('onboarding.model.keyPersistHint');
      panel.append(hint);
      const env = textInput('text', 'MINIBOT_API_KEY');
      env.id = 'provider-api-key-env';
      this.apiKeyEnvInput = env;
      panel.append(labeled(t('onboarding.model.apiKeyEnv'), env));
    }

    const contextWindow = textInput('number');
    contextWindow.id = 'provider-context-window';
    contextWindow.min = '1';
    contextWindow.addEventListener('input', () => {
      this.contextTouched = true;
    });
    this.contextWindowInput = contextWindow;
    panel.append(labeled(t('onboarding.model.contextWindow'), contextWindow));

    const test = document.createElement('button');
    test.type = 'button';
    test.id = 'test-connection';
    test.className = 'secondary test-button';
    test.textContent = t('onboarding.model.test');
    test.addEventListener('click', () => {
      void this.testConnection();
    });
    this.testButton = test;
    panel.append(test);

    const required = div('hint');
    required.textContent = t('onboarding.model.requiredHint');
    panel.append(required);
    return panel;
  }

  private buildProfileStep(): HTMLDivElement {
    const panel = div('step-panel');
    const intro = div('step-intro');
    intro.textContent = t('onboarding.profile.intro');
    const skip = div('hint');
    skip.textContent = t('onboarding.skipHint');
    panel.append(intro, skip);
    const textarea = document.createElement('textarea');
    textarea.id = 'profile';
    textarea.rows = 8;
    textarea.placeholder = t('onboarding.profile.placeholder');
    this.profileInput = textarea;
    panel.append(labeled(t('onboarding.profile.label'), textarea));
    return panel;
  }

  private buildBotStep(): HTMLDivElement {
    const panel = div('step-panel');
    const intro = div('step-intro');
    intro.textContent = t('onboarding.bot.intro');
    const skip = div('hint');
    skip.textContent = t('onboarding.skipHint');
    panel.append(intro, skip);
    const name = textInput('text', t('onboarding.bot.namePlaceholder'));
    name.id = 'bot-name';
    this.botNameInput = name;
    const persona = textInput('text', t('onboarding.bot.personaPlaceholder'));
    persona.id = 'bot-persona';
    this.botPersonaInput = persona;
    panel.append(
      labeled(t('onboarding.bot.name'), name),
      labeled(t('onboarding.bot.persona'), persona),
    );
    return panel;
  }

  private buildWorkspaceStep(): HTMLDivElement {
    const panel = div('step-panel');
    const intro = div('step-intro');
    intro.textContent = t('onboarding.workspace.intro');
    const skip = div('hint');
    skip.textContent = t('onboarding.skipHint');
    panel.append(intro, skip);
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

  private renderStep(animate = true): void {
    const keys = [
      'onboarding.step.model',
      'onboarding.step.profile',
      'onboarding.step.bot',
      'onboarding.step.workspace',
    ] as const;
    this.panels.forEach((panel, index) => {
      panel.classList.toggle('is-active', index === this.step);
    });
    if (this.stepTitle !== undefined) this.stepTitle.textContent = t(keys[this.step]);
    if (this.progress !== undefined) {
      this.progress.textContent = t('onboarding.step.progress', {
        current: this.step + 1,
        total: this.panels.length,
      });
    }
    if (this.backButton !== undefined) this.backButton.style.visibility = this.step > 0 ? 'visible' : 'hidden';
    if (this.nextButton !== undefined) {
      this.nextButton.textContent =
        this.step === this.panels.length - 1 ? t('onboarding.finish') : t('common.next');
    }
    if (animate && this.card !== undefined) {
      this.card.classList.remove('step-enter');
      void this.card.offsetWidth;
      this.card.classList.add('step-enter');
    }
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
    this.clearStatus();
    try {
      if (this.step === 0) {
        const model = this.requireModel();
        const contextWindow = Number(this.contextWindowInput?.value ?? '');
        this.draft.model = model;
        this.draft.contextWindow =
          Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
        await this.ensureProvider();
        this.step = 1;
      } else if (this.step === 1) {
        this.draft.profile = this.profileInput?.value.trim() ?? '';
        this.step = 2;
      } else if (this.step === 2) {
        this.draft.name = this.botNameInput?.value.trim() ?? '';
        this.draft.persona = this.botPersonaInput?.value.trim() ?? '';
        this.step = 3;
      } else {
        await this.finish();
        return;
      }
      this.renderStep();
    } catch (err) {
      const message = err instanceof Error ? err.message : messageOf(err);
      this.showStatus(message, true);
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
