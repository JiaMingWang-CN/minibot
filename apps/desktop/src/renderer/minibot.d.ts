export {};

declare global {
  interface Window {
    minibot: {
      connection(): Promise<{ port: number; token: string }>;
      setTitleBar(theme: 'dark' | 'light'): void;
    };
  }
}
