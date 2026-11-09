import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800 focus-visible:outline-slate-900',
  secondary:
    'bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-slate-900',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 focus-visible:outline-rose-600',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-slate-900',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const sizing = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm';
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
