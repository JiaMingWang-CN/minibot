// minibot 品牌符号（docs/brand/minibot-symbol.svg）：圆角方头 + 一圆一条两只眼。
// 头用墨色、眼用对话区底色，浅色主题是黑头白眼，深色主题自动反白。
// 小尺寸（≤ 24px）用 docs/brand 的小号切割：眼睛更大、更粗，缩小后仍能看清。

export const HEAD_PATH = 'M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52Z';
export const EYES_PATH = 'M98 106a20 20 0 1 0 0 40a20 20 0 1 0 0 -40ZM142 128h46v18h-46Z';
const EYES_SMALL_PATH = 'M96 102a24 24 0 1 0 0 48a24 24 0 1 0 0 -48ZM140 126h52v24h-52Z';

export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="28 28 200 200" width={size} height={size} className={className} aria-hidden="true">
      <path className="fill-ink" d={HEAD_PATH} />
      <path className="fill-app" d={size <= 24 ? EYES_SMALL_PATH : EYES_PATH} />
    </svg>
  );
}
