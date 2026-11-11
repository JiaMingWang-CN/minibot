// preload.cts 通过 contextBridge 暴露给页面的接口
interface Window {
  minibot: {
    connection(): Promise<{ port: number; token: string }>;
    /** 让 Electron 标题栏覆盖层（窗口按钮区域）的颜色跟随页面 */
    setTitleBar(colors: { color: string; symbolColor: string }): void;
    openMemoryDir(botId: string): Promise<void>;
  };
}
