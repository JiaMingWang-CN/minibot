import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, KernelEvent, KernelState } from '@minibot/core';
import { Loader2 } from 'lucide-react';
import { createApi, connectEvents, type Api, type EventConnection, type PresetWithModels } from './api';
import { FrameBar } from './FrameBar';
import { t } from './i18n';
import { Splash, prefersReducedMotion } from './splash/Splash';
import { Onboarding } from './onboarding/Onboarding';
import { MainScreen } from './main/MainScreen';

export type Subscribe = (listener: (event: KernelEvent) => void) => () => void;

interface Boot {
  api: Api;
  events: EventConnection;
  subscribe: Subscribe;
  state: KernelState;
  presets: PresetWithModels[];
}

function mainBot(state: KernelState): Bot | undefined {
  return state.bots.find((b) => b.id === state.mainBotId) ?? state.bots[0];
}

export function App() {
  // 开机动画与连接内核同时进行；两者都结束后再进入界面
  const [splashDone, setSplashDone] = useState(prefersReducedMotion);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bot, setBot] = useState<Bot | null>(null);
  const listeners = useRef(new Set<(event: KernelEvent) => void>());
  const endSplash = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    let events: EventConnection | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const conn = await window.minibot.connection();
        const api = createApi(conn);
        events = connectEvents(conn, (event) => {
          for (const listener of listeners.current) listener(event);
        });
        const [state, presets] = await Promise.all([api.state(), api.presets()]);
        if (cancelled) return;
        const subscribe: Subscribe = (listener) => {
          listeners.current.add(listener);
          return () => listeners.current.delete(listener);
        };
        setBoot({ api, events, subscribe, state, presets });
        if (state.onboarded) setBot(mainBot(state) ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      events?.close();
    };
  }, []);

  let content;
  if (error !== null) {
    content = <p className="m-auto max-w-md text-center text-[14px] text-danger">{t('app.error', { message: error })}</p>;
  } else if (boot === null || !splashDone) {
    content = splashDone && (
      <p role="status" className="m-auto flex items-center gap-2 text-[13px] text-ink-secondary">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        {t('app.connecting')}
      </p>
    );
  } else if (bot !== null) {
    return (
      <MainScreen
        api={boot.api}
        events={boot.events}
        subscribe={boot.subscribe}
        bot={bot}
        providers={boot.state.providers}
        presets={boot.presets}
        onBotChange={setBot}
        secretsUnreadable={boot.state.secretsUnreadable}
        canPersistKeys={boot.state.canPersistKeys}
        onRefresh={async () => {
          const state = await boot.api.state();
          setBoot((b) => b && { ...b, state });
        }}
      />
    );
  } else {
    content = (
      <Onboarding
        api={boot.api}
        canPersistKeys={boot.state.canPersistKeys}
        presets={boot.presets}
        onDone={(created) => {
          // 初始化新加了供应商：刷新状态，模型菜单才列得出它
          void boot.api
            .state()
            .then((state) => setBoot((b) => b && { ...b, state }))
            .catch(() => {});
          setBot(created);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-app">
      <FrameBar />
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
      {!splashDone && <Splash onDone={endSplash} />}
    </div>
  );
}
