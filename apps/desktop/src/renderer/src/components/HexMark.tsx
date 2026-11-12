interface HexMarkProps {
  size?: number;
  className?: string;
}

/** The Insectoids mark: a honey hexagon ring with a solid core. Decorative. */
export function HexMark({ size = 26, className }: HexMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="none" stroke="var(--honey)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 7.5l3.9 2.25v4.5L12 16.5l-3.9-2.25v-4.5z" fill="var(--honey)" />
    </svg>
  );
}
