import type {
  ApiFormat,
  Bot,
  KernelState,
  Provider,
  ThinkingLevel,
  TestConnectionResult,
} from '@minibot/core';
import { t } from '../i18n/index.js';
import type { Api, PresetWithModels } from '../api.js';
import type { View } from './onboarding.js';

const FORMATS: { value: ApiFormat; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
];

const ALL_LEVELS: ThinkingLevel[] = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  const wrapper = div('settings-field');
  const label = document.createElement('label');
  label.textContent = labelText;
  label.append(control);
  wrapper.append(label);
  return wrapper;
}

function textInput(type: string, placeholder = ''): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  return input;
}

function selectInput(
  options: { value: string; label: string }[],
  value: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.value = value;
  return select;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SettingsView implements View {
  private api: Api;
  private bot: Bot;
  private presets: PresetWithModels[];
  private state: KernelState;
  private onBack: () => void;
  private onBotUpdated: (bot: Bot) => void;

  private providerList: HTMLElement | undefined;
  private providerStatus: HTMLElement | undefined;
  private botProvider: HTMLSelectElement | undefined;
  private botModel: HTMLInputElement | undefined;
  private thinkingSelect: HTMLSelectElement | undefined;
  private botStatus: HTMLElement | undefined;
  private consolidationProvider: HTMLSelectElement | undefined;
  private consolidationModel: HTMLInputElement | undefined;
  private consolidationStatus: HTMLElement | undefined;

  private nameInput: HTMLInputElement | undefined;
  private personaInput: HTMLTextAreaElement | undefined;
  private contextWindowInput: HTMLInputElement | undefined;
  private maxOutputTokensInput: HTMLInputElement | undefined;
  private workspaceInput: HTMLInputElement | undefined;
  private approvalSelect: HTMLSelectElement | undefined;
  private approvalWarning: HTMLElement | undefined;

  constructor(
    api: Api,
    bot: Bot,
    presets: PresetWithModels[],
    state: KernelState,
    onBack: () => void,
    onBotUpdated: (bot: Bot) => void,
  ) {
    this.api = api;
    this.bot = bot;
    this.presets = presets;
    this.state = state;
    this.onBack = onBack;
    this.onBotUpdated = onBotUpdated;
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
    title.textContent = t('settings.title');
    header.append(back, title);

    const body = div('settings-body');
    body.append(this.buildProvidersSection(), this.buildBotSection(), this.buildConsolidationSection());
    page.append(header, body);
    el.replaceChildren(page);
    this.renderProviderList();
    this.renderBotFields();
    void this.loadConsolidation();
  }

  private buildProvidersSection(): HTMLElement {
    const section = div('settings-section');
    const title = div('section-title');
    title.textContent = t('settings.providers');
    section.append(title);

    const add = div('settings-add');
    const presetSelect = selectInput(
      this.presets.map((preset) => ({ value: preset.id, label: preset.name })),
      this.presets[0]?.id ?? '',
    );
    const addName = textInput('text');
    const addFormat = selectInput(
      FORMATS.map((format) => ({ value: format.value, label: format.label })),
      'chat_completions',
    );
    const addBaseUrl = textInput('text', 'https://');
    let addKey: HTMLInputElement | undefined;
    let addKeyEnv: HTMLInputElement | undefined;
    if (this.state.canPersistKeys) addKey = textInput('password');
    else addKeyEnv = textInput('text', 'MINIBOT_API_KEY');
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'primary small';
    addButton.textContent = t('settings.provider.add');
    addButton.addEventListener('click', () => {
      void this.addProvider(
        presetSelect,
        addName,
        addFormat,
        addBaseUrl,
        addKey,
        addKeyEnv,
      );
    });

    const applyPreset = (): void => {
      const preset = this.presets.find((item) => item.id === presetSelect.value);
      if (preset === undefined) return;
      addName.value = preset.name;
      addFormat.value = preset.format;
      addBaseUrl.value = preset.baseUrl;
    };
    presetSelect.addEventListener('change', applyPreset);
    applyPreset();

    add.append(
      field(t('settings.provider.preset'), presetSelect),
      field(t('settings.provider.name'), addName),
      field(t('settings.provider.format'), addFormat),
      field(t('settings.provider.baseUrl'), addBaseUrl),
    );
    if (addKey !== undefined) add.append(field(t('settings.provider.apiKey'), addKey));
    if (addKeyEnv !== undefined) add.append(field(t('settings.provider.apiKeyEnv'), addKeyEnv));
    add.append(addButton);

    const status = div('settings-status');
    this.providerStatus = status;
    const list = div('provider-list');
    this.providerList = list;
    section.append(add, status, list);
    return section;
  }

  private renderProviderList(): void {
    if (this.providerList === undefined) return;
    this.providerList.replaceChildren();
    for (const provider of this.state.providers) {
      this.providerList.append(this.providerRow(provider));
    }
    this.renderProviderOptions();
  }

  private providerRow(provider: Provider & { hasKey: boolean }): HTMLElement {
    const row = div('settings-row');
    const name = textInput('text');
    name.value = provider.name;
    const format = selectInput(
      FORMATS.map((item) => ({ value: item.value, label: item.label })),
      provider.format,
    );
    const baseUrl = textInput('text');
    baseUrl.value = provider.baseUrl;
    const env = textInput('text');
    env.value = provider.apiKeyEnv ?? '';
    const key = this.state.canPersistKeys ? textInput('password') : undefined;
    const keyLabel = div('hint');
    keyLabel.textContent = provider.hasKey
      ? t('settings.provider.keyStored')
      : t('settings.provider.keyMissing');
    const testModel = textInput('text');
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'secondary small';
    testButton.textContent = t('settings.provider.test');
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'primary small';
    saveButton.textContent = t('settings.provider.save');
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger small';
    deleteButton.textContent = t('settings.provider.delete');
    const status = div('settings-status');

    testButton.addEventListener('click', () => {
      void this.testProvider(provider.id, testModel.value, status);
    });
    saveButton.addEventListener('click', () => {
      void this.saveProvider(provider.id, name, format, baseUrl, env, key, status);
    });
    deleteButton.addEventListener('click', () => {
      void this.deleteProvider(provider.id, status);
    });

    row.append(
      field(t('settings.provider.name'), name),
      field(t('settings.provider.format'), format),
      field(t('settings.provider.baseUrl'), baseUrl),
      field(t('settings.provider.apiKeyEnv'), env),
    );
    if (key !== undefined) row.append(field(t('settings.provider.apiKey'), key));
    const actions = div('settings-row-actions');
    actions.append(keyLabel);
    actions.append(testModel, testButton, saveButton, deleteButton);
    row.append(field(t('settings.provider.testModel'), testModel), actions, status);
    return row;
  }

  private renderProviderOptions(): void {
    if (this.botProvider !== undefined) {
      const current = this.botProvider.value;
      this.botProvider.replaceChildren(
        ...this.state.providers.map((provider) => {
          const option = document.createElement('option');
          option.value = provider.id;
          option.textContent = provider.name;
          return option;
        }),
      );
      this.botProvider.value =
        this.state.providers.some((p) => p.id === current) ? current : (this.bot.providerId ?? '');
    }
    if (this.consolidationProvider !== undefined) {
      const current = this.consolidationProvider.value;
      this.consolidationProvider.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('settings.bot.thinkingDefault');
      this.consolidationProvider.append(empty);
      for (const provider of this.state.providers) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.name;
        this.consolidationProvider.append(option);
      }
      if (this.state.providers.some((p) => p.id === current)) this.consolidationProvider.value = current;
    }
  }

  private async addProvider(
    presetSelect: HTMLSelectElement,
    name: HTMLInputElement,
    format: HTMLSelectElement,
    baseUrl: HTMLInputElement,
    key: HTMLInputElement | undefined,
    env: HTMLInputElement | undefined,
  ): Promise<void> {
    try {
      const presetId = presetSelect.value;
      const input = {
        name: name.value.trim(),
        format: format.value as ApiFormat,
        baseUrl: baseUrl.value.trim(),
        presetId,
      } as {
        name: string;
        format: ApiFormat;
        baseUrl: string;
        presetId: string;
        apiKey?: string;
        apiKeyEnv?: string;
      };
      if (key !== undefined && key.value.trim().length > 0) input.apiKey = key.value.trim();
      if (env !== undefined && env.value.trim().length > 0) input.apiKeyEnv = env.value.trim();
      await this.api.addProvider(input);
      if (this.providerStatus !== undefined) this.providerStatus.textContent = t('settings.bot.saved');
      name.value = '';
      if (key !== undefined) key.value = '';
      await this.refreshProviders();
    } catch (err) {
      this.providerStatusError(err);
    }
  }

  private async saveProvider(
    providerId: string,
    name: HTMLInputElement,
    format: HTMLSelectElement,
    baseUrl: HTMLInputElement,
    env: HTMLInputElement,
    key: HTMLInputElement | undefined,
    status: HTMLElement,
  ): Promise<void> {
    try {
      const patch: Parameters<Api['updateProvider']>[1] = {
        name: name.value.trim(),
        format: format.value as ApiFormat,
        baseUrl: baseUrl.value.trim(),
      };
      if (env.value.trim().length > 0) patch.apiKeyEnv = env.value.trim();
      if (key !== undefined && key.value.trim().length > 0) patch.apiKey = key.value.trim();
      await this.api.updateProvider(providerId, patch);
      if (key !== undefined) key.value = '';
      status.textContent = t('settings.bot.saved');
      await this.refreshProviders();
    } catch (err) {
      status.textContent = t('settings.error', { message: messageOf(err) });
    }
  }

  private async deleteProvider(providerId: string, status: HTMLElement): Promise<void> {
    try {
      await this.api.deleteProvider(providerId);
      await this.refreshProviders();
    } catch (err) {
      status.textContent = t('settings.error', { message: messageOf(err) });
    }
  }

  private async testProvider(
    providerId: string,
    model: string,
    status: HTMLElement,
  ): Promise<void> {
    try {
      const result = await this.api.testProvider(providerId, model.trim());
      status.textContent = this.testLabel(result);
    } catch (err) {
      status.textContent = t('settings.error', { message: messageOf(err) });
    }
  }

  private testLabel(result: TestConnectionResult): string {
    if (result.ok) return t('onboarding.model.testOk');
    if (result.kind === 'auth') return t('onboarding.model.testAuth');
    if (result.kind === 'url') return t('onboarding.model.testUrl');
    if (result.kind === 'network') return t('onboarding.model.testNetwork');
    return t('onboarding.model.testOther', { message: result.message });
  }

  private async refreshProviders(): Promise<void> {
    try {
      this.state = await this.api.state();
      const updated = this.state.bots.find((item) => item.id === this.bot.id);
      if (updated !== undefined) this.bot = updated;
      this.renderProviderList();
    } catch (err) {
      this.providerStatusError(err);
    }
  }

  private providerStatusError(err: unknown): void {
    if (this.providerStatus !== undefined) {
      this.providerStatus.textContent = t('settings.error', { message: messageOf(err) });
    }
  }

  private buildBotSection(): HTMLElement {
    const section = div('settings-section');
    const title = div('section-title');
    title.textContent = t('settings.bot');

    const name = textInput('text');
    const persona = document.createElement('textarea');
    persona.rows = 4;
    const provider = selectInput(
      this.state.providers.map((item) => ({ value: item.id, label: item.name })),
      this.bot.providerId,
    );
    const model = textInput('text');
    const contextWindow = textInput('number');
    const maxOutputTokens = textInput('number');
    const workspace = textInput('text', t('settings.bot.workspacePlaceholder'));
    const thinking = selectInput([], '');
    const approval = selectInput(
      [
        { value: 'ask', label: t('settings.bot.approvalAsk') },
        { value: 'auto', label: t('settings.bot.approvalAuto') },
      ],
      this.bot.approvalMode,
    );
    const warning = div('settings-warning');
    warning.textContent = t('settings.bot.autoWarning');
    const status = div('settings-status');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = t('settings.bot.save');
    save.addEventListener('click', () => {
      void this.saveBot(status);
    });

    this.nameInput = name;
    this.personaInput = persona;
    this.botProvider = provider;
    this.botModel = model;
    this.contextWindowInput = contextWindow;
    this.maxOutputTokensInput = maxOutputTokens;
    this.workspaceInput = workspace;
    this.thinkingSelect = thinking;
    this.approvalSelect = approval;
    this.approvalWarning = warning;
    this.botStatus = status;

    const refreshThinking = (): void => {
      this.refreshThinking();
    };
    provider.addEventListener('change', refreshThinking);
    model.addEventListener('input', refreshThinking);
    approval.addEventListener('change', () => {
      this.updateWarning();
    });

    section.append(
      title,
      field(t('settings.bot.name'), name),
      field(t('settings.bot.persona'), persona),
      field(t('settings.bot.provider'), provider),
      field(t('settings.bot.model'), model),
      field(t('settings.bot.contextWindow'), contextWindow),
      field(t('settings.bot.maxOutputTokens'), maxOutputTokens),
      field(t('settings.bot.workspace'), workspace),
      field(t('settings.bot.thinkingLevel'), thinking),
      field(t('settings.bot.approvalMode'), approval),
      warning,
      save,
      status,
    );
    return section;
  }

  private renderBotFields(): void {
    if (
      this.nameInput === undefined ||
      this.personaInput === undefined ||
      this.botModel === undefined ||
      this.contextWindowInput === undefined ||
      this.maxOutputTokensInput === undefined ||
      this.workspaceInput === undefined
    ) {
      return;
    }
    this.nameInput.value = this.bot.name;
    this.personaInput.value = this.bot.persona;
    this.botModel.value = this.bot.model;
    this.contextWindowInput.value = String(this.bot.contextWindow);
    this.maxOutputTokensInput.value = String(this.bot.maxOutputTokens);
    this.workspaceInput.value = this.bot.workspace ?? '';
    if (this.botProvider !== undefined) this.botProvider.value = this.bot.providerId;
    if (this.approvalSelect !== undefined) this.approvalSelect.value = this.bot.approvalMode;
    this.refreshThinking();
    if (
      this.thinkingSelect !== undefined &&
      !this.thinkingSelect.disabled &&
      this.bot.thinkingLevel !== null &&
      this.thinkingSelect.value === ''
    ) {
      this.thinkingSelect.value = this.bot.thinkingLevel;
    }
    this.updateWarning();
  }

  private levelsFor(providerId: string, model: string): ThinkingLevel[] {
    const provider = this.state.providers.find((item) => item.id === providerId);
    if (provider === undefined) return [...ALL_LEVELS];
    const preset = this.presets.find((item) => item.id === provider.presetId);
    if (preset === undefined) {
      return provider.format === 'anthropic_messages'
        ? ['off', 'low', 'medium', 'high', 'xhigh', 'max']
        : [...ALL_LEVELS];
    }
    if (preset.thinkingLevels.length === 0) return [];
    const known = preset.models.find(
      (item) => item.id.toLowerCase() === model.trim().toLowerCase(),
    );
    if (known?.thinkingLevels !== undefined) return [...known.thinkingLevels];
    return [...preset.thinkingLevels];
  }

  private refreshThinking(): void {
    if (
      this.thinkingSelect === undefined ||
      this.botProvider === undefined ||
      this.botModel === undefined
    ) {
      return;
    }
    const levels = this.levelsFor(this.botProvider.value, this.botModel.value);
    const current = this.thinkingSelect.value;
    this.thinkingSelect.replaceChildren();
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = t('settings.bot.thinkingDefault');
    this.thinkingSelect.append(fallback);
    for (const level of levels) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level;
      this.thinkingSelect.append(option);
    }
    this.thinkingSelect.disabled = levels.length === 0;
    this.thinkingSelect.value = levels.includes(current as ThinkingLevel) ? current : '';
  }

  private updateWarning(): void {
    if (this.approvalWarning === undefined || this.approvalSelect === undefined) return;
    this.approvalWarning.classList.toggle(
      'is-visible',
      this.approvalSelect.value === 'auto',
    );
  }

  private async saveBot(status: HTMLElement): Promise<void> {
    try {
      const patch: Parameters<Api['updateBot']>[1] = {
        name: this.nameInput?.value.trim() ?? '',
        persona: this.personaInput?.value ?? '',
        providerId: this.botProvider?.value ?? '',
        model: this.botModel?.value.trim() ?? '',
        contextWindow: Number(this.contextWindowInput?.value ?? 0),
        maxOutputTokens: Number(this.maxOutputTokensInput?.value ?? 0),
        workspace:
          this.workspaceInput !== undefined && this.workspaceInput.value.trim().length > 0
            ? this.workspaceInput.value.trim()
            : null,
        approvalMode: (this.approvalSelect?.value ?? 'ask') as 'ask' | 'auto',
        thinkingLevel:
          this.thinkingSelect !== undefined && this.thinkingSelect.value.length > 0
            ? (this.thinkingSelect.value as ThinkingLevel)
            : null,
      };
      const updated = await this.api.updateBot(this.bot.id, patch);
      this.bot = updated;
      status.textContent = t('settings.bot.saved');
      this.renderBotFields();
      this.onBotUpdated(updated);
    } catch (err) {
      status.textContent = t('settings.error', { message: messageOf(err) });
    }
  }

  private buildConsolidationSection(): HTMLElement {
    const section = div('settings-section');
    const title = div('section-title');
    title.textContent = t('settings.consolidation');
    const hint = div('hint');
    hint.textContent = t('settings.consolidation.hint');

    const provider = selectInput(
      [
        { value: '', label: t('settings.bot.thinkingDefault') },
        ...this.state.providers.map((item) => ({ value: item.id, label: item.name })),
      ],
      '',
    );
    const model = textInput('text');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary small';
    save.textContent = t('settings.consolidation.save');
    save.addEventListener('click', () => {
      void this.saveConsolidation();
    });
    const status = div('settings-status');

    this.consolidationProvider = provider;
    this.consolidationModel = model;
    this.consolidationStatus = status;
    section.append(
      title,
      hint,
      field(t('settings.consolidation.provider'), provider),
      field(t('settings.consolidation.model'), model),
      save,
      status,
    );
    return section;
  }

  private async loadConsolidation(): Promise<void> {
    try {
      const settings = await this.api.settings();
      const configured = settings.consolidationModel;
      if (this.consolidationProvider !== undefined) {
        this.consolidationProvider.value = configured?.providerId ?? '';
      }
      if (this.consolidationModel !== undefined) {
        this.consolidationModel.value = configured?.model ?? '';
      }
    } catch (err) {
      if (this.consolidationStatus !== undefined) {
        this.consolidationStatus.textContent = t('settings.error', { message: messageOf(err) });
      }
    }
  }

  private async saveConsolidation(): Promise<void> {
    if (this.consolidationStatus === undefined) return;
    try {
      const providerId = this.consolidationProvider?.value ?? '';
      if (providerId.length === 0) {
        await this.api.updateSettings({ consolidationModel: null });
        this.consolidationStatus.textContent = t('settings.bot.saved');
        return;
      }
      const model = this.consolidationModel?.value.trim() ?? '';
      if (model.length === 0) {
        this.consolidationStatus.textContent = t('settings.error', {
          message: t('onboarding.error.modelRequired'),
        });
        return;
      }
      await this.api.updateSettings({ consolidationModel: { providerId, model } });
      this.consolidationStatus.textContent = t('settings.bot.saved');
    } catch (err) {
      this.consolidationStatus.textContent = t('settings.error', { message: messageOf(err) });
    }
  }
}
