import type { ComponentPropsWithoutRef } from 'react';
import { useSpotlight } from '../../useSpotlight';

/** A dark surface whose border lights up under the pointer. For other elements, put the `glow` class on them and spread `useSpotlight()`. */
export function Glow({ className = '', ...rest }: ComponentPropsWithoutRef<'div'>) {
  const spotlight = useSpotlight();
  return <div {...rest} {...spotlight} className={`glow ${className}`} />;
}
