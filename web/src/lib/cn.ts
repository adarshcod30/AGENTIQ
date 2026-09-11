import clsx, { type ClassValue } from 'clsx';

/** Class-name join. Kept trivial on purpose: no tailwind-merge dependency. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
