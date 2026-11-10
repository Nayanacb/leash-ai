import { formatMinorAsDecimal, type Currency } from '@leash/shared';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatMoney(amountMinor: number, currency: Currency): string {
  return `${formatMinorAsDecimal(amountMinor, currency)} ${currency}`;
}

/** Relative time for recent events ("3 min ago"), absolute otherwise. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const sign = diff >= 0 ? -1 : 1;
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(sign * Math.round(abs / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(sign * Math.round(abs / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(sign * Math.round(abs / 86_400_000), 'day');
  return formatDateTime(iso);
}

/** Value for <input type="datetime-local"> from a Date, in local time. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}
