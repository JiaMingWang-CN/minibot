// preload.cts 通过 contextBridge 暴露给页面的接口

/** 应用内更新的当前状态（主进程 updater.cts 推送） */
interface UpdateState {
  phase: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

interface Window {
  minibot: {
    connection(): Promise<{ port: number; token: string }>;
    /** 让 Electron 标题栏覆盖层（窗口按钮区域）的颜色跟随页面 */
    setTitleBar(colors: { color: string; symbolColor: string }): void;
    openMemoryDir(botId: string): Promise<void>;
    /** 选文件夹（安装插件 / 添加 skill）；取消时返回 null */
    pickFolder(): Promise<string | null>;
    /** 选 zip 文件（安装插件）；取消时返回 null */
    pickZip(): Promise<string | null>;
    update: {
      state(): Promise<UpdateState>;
      check(): Promise<UpdateState>;
      install(): Promise<void>;
      /** 订阅主进程推送的状态；返回取消订阅 */
      onState(cb: (state: UpdateState) => void): () => void;
    };
  };
}
