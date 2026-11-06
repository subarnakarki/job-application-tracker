import type { ComponentPropsWithoutRef } from 'react';
import { useSpotlight } from '../../useSpotlight';

/**
 * A dark surface whose border lights up under the pointer. `as="section"` gives it a landmark
 * role when it is named (aria-labelledby). For other elements, put the `glow` class on them and
 * spread `useSpotlight()`.
 */
export function Glow({
  as: Tag = 'div',
  className = '',
  ...rest
}: ComponentPropsWithoutRef<'div'> & { as?: 'div' | 'section' | 'article' }) {
  const spotlight = useSpotlight();
  return <Tag {...rest} {...spotlight} className={`glow ${className}`} />;
}
