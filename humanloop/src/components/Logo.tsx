// HumanLoop logo mark (from appicons.svg): the squishy blob with white glasses.
const fills = {
  mint: "#c3e4d3",
  green: "#6dc497",
  blue: "#1daae1",
  navy: "#2b55a6",
} as const;

export function Logo({ variant = "green", height = 30, className = "" }: { variant?: keyof typeof fills; height?: number; className?: string }) {
  return (
    <svg
      className={`logo-mark ${className}`}
      viewBox="140 89 168 114"
      height={height}
      width={(height * 168) / 114}
      role="img"
      aria-label="HumanLoop logo"
    >
      <path
        fill={fills[variant]}
        d="M304.15,160.32c0,37.89-34.19,40.49-78.67,40.49s-82.42-2.6-82.42-40.49,36.06-68.61,80.54-68.61,80.54,30.72,80.54,68.61Z"
      />
      <g fill="none" stroke="#fff" strokeMiterlimit="10" strokeWidth="3">
        <circle cx="197.98" cy="161.25" r="17.53" />
        <circle cx="249.92" cy="161.25" r="17.53" />
        <line x1="215.51" y1="161.25" x2="232.38" y2="161.25" />
      </g>
    </svg>
  );
}
