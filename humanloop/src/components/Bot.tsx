import { useId } from "react";

type BotState = "idle" | "listening" | "speaking";

/**
 * The HumanLoop bot (head from humanloopai.svg). Animated so the voice
 * appears to come from it: it bounces and its mouth moves while speaking.
 */
export function Bot({ state = "idle", level = 0, className = "" }: { state?: BotState; level?: number; className?: string }) {
  const gid = `bot-grad-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const lift = state === "listening" ? Math.min(level * 5, 0.12) : 0;

  return (
    <div className={`bot ${state} ${className}`} style={{ transform: lift ? `scale(${1 + lift})` : undefined }}>
      <span className="bot-ring" aria-hidden="true" />
      <span className="bot-ring r2" aria-hidden="true" />
      <svg className="bot-svg" viewBox="1362 108 292 202" role="img" aria-label="HumanLoop assistant">
        <defs>
          <radialGradient id={gid} cx="1508.88" cy="209.6" fx="1508.88" fy="209.6" r="117.27" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6dc497" />
            <stop offset=".38" stopColor="#6ac399" />
            <stop offset=".58" stopColor="#63c0a0" />
            <stop offset=".73" stopColor="#57bbae" />
            <stop offset=".86" stopColor="#45b5c0" />
            <stop offset=".97" stopColor="#2eacd9" />
            <stop offset="1" stopColor="#27aae1" />
          </radialGradient>
        </defs>
        <path
          fill={`url(#${gid})`}
          d="M1646.2,233.57c0,64.6-58.28,69.02-134.12,69.02s-140.51-4.43-140.51-69.02,61.48-116.97,137.32-116.97,137.32,52.37,137.32,116.97Z"
        />
        <g fill="none" stroke="#000" strokeMiterlimit="10" strokeWidth="3">
          <circle cx="1465.18" cy="235.15" r="29.89" />
          <circle cx="1553.73" cy="235.15" r="29.89" />
          <line x1="1495.07" y1="235.15" x2="1523.83" y2="235.15" />
        </g>
        <circle className="bot-eye" cx="1464.44" cy="236.76" r="5.88" />
        <circle className="bot-eye" cx="1552.21" cy="236.76" r="5.88" />
        <circle className="bot-mouth-o" cx="1509.45" cy="278" r="9" fill="#111" />
        <path
          className="bot-mouth"
          fill="none"
          stroke="#000"
          strokeWidth="2"
          strokeMiterlimit="10"
          d="M1495.07,270.92c0,4.17,6.22,7.8,14.38,7.61s14.38-3.65,14.38-7.61"
        />
      </svg>
    </div>
  );
}
