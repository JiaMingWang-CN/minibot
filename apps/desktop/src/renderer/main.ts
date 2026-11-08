import type { Bot, KernelEvent, KernelState } from '@minibot/core';
import {
  createApi,
  connectEvents,
  type Api,
  type EventConnection,
  type PresetWithModels,
} from './api.js';
import { t } from './i18n/index.js';
import { OnboardingView, type View } from './views/onboarding.js';
import { ChatView } from './views/chat.js';
import { MemoryView } from './views/memory.js';
import { SettingsView } from './views/settings.js';
import { playSplash } from './views/splash.js';

let current: View | undefined;
let eventsConnection: EventConnection | undefined;
let rootEl: HTMLElement | undefined;
let apiRef: Api | undefined;
let botRef: Bot | undefined;

export function mount(el: HTMLElement, view: View): void {
  current?.dispose?.();
  current = view;
  el.replaceChildren();
  view.mount(el);
}

function showChat(): void {
  if (rootEl === undefined || apiRef === undefined || botRef === undefined) return;
  const view = new ChatView(apiRef, botRef, (message) => eventsConnection?.send(message), {
    onOpenMemory: () => {
      void openMemory();
    },
    onOpenSettings: () => {
      void openSettings();
    },
  });
  mount(rootEl, view);
}

function pickBot(state: KernelState): Bot | undefined {
  return state.bots.find((item) => item.id === state.mainBotId) ?? state.bots[0];
}

async function openChat(): Promise<void> {
  if (apiRef === undefined || rootEl === undefined) return;
  try {
    const state = await apiRef.state();
    const bot = pickBot(state);
    if (bot === undefined) throw new Error('no bot');
    botRef = bot;
    showChat();
  } catch (err) {
    rootEl.className = 'fatal';
    rootEl.textContent = t('common.error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function openMemory(): Promise<void> {
  if (apiRef === undefined || botRef === undefined || rootEl === undefined) return;
  mount(rootEl, new MemoryView(apiRef, botRef, () => void openChat()));
}

async function openSettings(): Promise<void> {
  if (apiRef === undefined || botRef === undefined || rootEl === undefined) return;
  try {
    const state = await apiRef.state();
    const presets: PresetWithModels[] = await apiRef.presets();
    const bot = state.bots.find((item) => item.id === botRef!.id) ?? pickBot(state);
    if (bot === undefined) throw new Error('no bot');
    botRef = bot;
    mount(
      rootEl,
      new SettingsView(
        apiRef,
        bot,
        presets,
        state,
        () => void openChat(),
        (updated) => {
          botRef = updated;
        },
      ),
    );
  } catch (err) {
    rootEl.className = 'fatal';
    rootEl.textContent = t('common.error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function connect(conn: Parameters<typeof createApi>[0]): void {
  eventsConnection = connectEvents(conn, (event: KernelEvent) => {
    current?.onEvent?.(event);
  });
}

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (root === null) return;
  rootEl = root;
  try {
    const conn = await window.minibot.connection();
    const api = createApi(conn);
    apiRef = api;
    connect(conn);
    const state = await api.state();
    if (state.secretsUnreadable) {
      const banner = document.createElement('div');
      banner.className = 'banner';
      banner.textContent = t('common.secretsUnreadable');
      root.before(banner);
    }
    if (!state.onboarded) {
      const presets = await api.presets();
      mount(
        root,
        new OnboardingView(api, state, presets, (bot) => {
          botRef = bot;
          showChat();
        }),
      );
      return;
    }
    const bot = pickBot(state);
    if (bot === undefined) throw new Error('no bot');
    botRef = bot;
    showChat();
  } catch (err) {
    root.className = 'fatal';
    root.textContent = t('common.error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

playSplash();
void start();
