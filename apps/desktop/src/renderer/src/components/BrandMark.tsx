import logo26 from '@/assets/logo-26.png';
import logo52 from '@/assets/logo-52.png';
import logo64 from '@/assets/logo-64.png';
import logo128 from '@/assets/logo-128.png';

/** Pre-rendered sizes from scripts/make-icons.mjs; small ones have thickened lines so they stay legible. */
const SOURCES = {
  26: { src: logo26, srcSet: `${logo26} 1x, ${logo52} 2x` },
  64: { src: logo64, srcSet: `${logo64} 1x, ${logo128} 2x` },
} as const;

interface BrandMarkProps {
  size?: keyof typeof SOURCES;
  className?: string;
}

/** The Insectoids logo: a honey insect head with honeycomb eyes. Decorative (the name is always next to it). */
export function BrandMark({ size = 26, className }: BrandMarkProps) {
  const { src, srcSet } = SOURCES[size];
  return (
    <img
      src={src}
      srcSet={srcSet}
      width={size}
      height={size}
      alt=""
      draggable={false}
      data-testid="brand-mark"
      className={className}
    />
  );
}
