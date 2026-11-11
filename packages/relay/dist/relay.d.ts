export declare const MAX_FRAME_BYTES = 67584;
export interface RelayOptions {
    host: string;
    port: number;
    token: string;
    now?: () => number;
    /** 只用于连接数变化与错误，绝不含负载 */
    log?: (message: string) => void;
    /** 测试用，默认 5000 */
    helloTimeoutMs?: number;
}
export interface RelayHandle {
    port: number;
    close(): Promise<void>;
}
export declare function startRelay(o: RelayOptions): Promise<RelayHandle>;
