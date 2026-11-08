export {};

declare global {
  interface Window {
    minibot: {
      connection(): Promise<{ port: number; token: string }>;
    };
  }
}
