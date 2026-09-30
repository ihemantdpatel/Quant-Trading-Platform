/**
 * Renders P&L summaries into email — pure, no I/O.
 *
 * HTML and plain text are both produced from the same summary object, so the
 * two parts of one message can never disagree on a figure. Styling is inline:
 * most mail clients (Gmail included) strip `<style>` blocks.
 */

import { DateTime } from 'luxon';
import { ExecutionMode } from '../config/execution-mode';
import { ET_ZONE } from '../market-data/types';
import { DailyPnl, PeriodPnl, PnlTotals } from './pnl-summary';

export interface EmailAccount {
  alias: string;
  mode: ExecutionMode;
}

export interface RenderOptions {
  /** Prepended to the subject, e.g. `[SAMPLE]`. */
  subjectPrefix?: string;
  /** Overrides the period's heading, e.g. `Last 7 days`. Defaults to the month. */
  periodLabel?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const GAIN = '#15803d';
const LOSS = '#b91c1c';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Signed money: `+$1,234.50` / `-$12.00`. Zero is unsigned. */
export function signedUsd(value: number): string {
  if (value === 0) {
    return usd.format(0);
  }
  return `${value > 0 ? '+' : '-'}${usd.format(Math.abs(value))}`;
}

/** A price: at least 2 decimals, up to 4 when the fill carried them. */
export function price(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function etTime(timestamp: string): string {
  return DateTime.fromISO(timestamp, { setZone: true }).setZone(ET_ZONE).toFormat('HH:mm');
}

/** `HH:mm` when on `date`, else `MMM d HH:mm` — a lot can be bought days before it sells. */
function etTimeOn(timestamp: string, date: string): string {
  const et = DateTime.fromISO(timestamp, { setZone: true }).setZone(ET_ZONE);
  return et.toISODate() === date ? et.toFormat('HH:mm') : et.toFormat('MMM d HH:mm');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `Fri, Sep 25, 2026` — the weekday makes a Monday email covering Friday obvious. */
export function longDate(date: string): string {
  return DateTime.fromISO(date, { zone: ET_ZONE }).toFormat('ccc, LLL d, yyyy');
}

/** `Sep 21 – Sep 27, 2026`, or with both years when the range crosses one. */
export function dateRange(from: string, to: string): string {
  const start = DateTime.fromISO(from, { zone: ET_ZONE });
  const end = DateTime.fromISO(to, { zone: ET_ZONE });
  return start.year === end.year
    ? `${start.toFormat('LLL d')} – ${end.toFormat('LLL d, yyyy')}`
    : `${start.toFormat('LLL d, yyyy')} – ${end.toFormat('LLL d, yyyy')}`;
}

function subjectTag(account: EmailAccount, options: RenderOptions): string {
  const prefix = options.subjectPrefix ? `${options.subjectPrefix} ` : '';
  return `${prefix}[IB ${account.alias} · ${account.mode}]`;
}

function tradeCount(n: number): string {
  return `${n} trade${n === 1 ? '' : 's'}`;
}

// --- HTML building blocks -------------------------------------------------

function money(value: number): string {
  const color = value < 0 ? LOSS : value > 0 ? GAIN : MUTED;
  return `<span style="color:${color};font-weight:600">${escapeHtml(signedUsd(value))}</span>`;
}

const cell = `padding:6px 10px;border-bottom:1px solid ${BORDER};`;
const headCell = `${cell}text-align:left;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;`;

function table(headers: string[], rows: string[][], numericFrom: number): string {
  const th = headers
    .map(
      (h, i) =>
        `<th style="${headCell}${i >= numericFrom ? 'text-align:right;' : ''}">${escapeHtml(h)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (value, i) =>
              `<td style="${cell}${i >= numericFrom ? 'text-align:right;white-space:nowrap;' : ''}">${value}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function totalsBlock(totals: PnlTotals): string {
  const row = (label: string, value: string, strong = false): string =>
    `<tr><td style="padding:4px 10px;color:${MUTED}">${escapeHtml(label)}</td>` +
    `<td style="padding:4px 10px;text-align:right;${strong ? 'font-size:18px;' : ''}">${value}</td></tr>`;

  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;margin-top:8px">
${row('Trades closed', String(totals.trades))}
${row('Gross capital gain', money(totals.gross))}
${row('Commissions paid (all fills)', escapeHtml(usd.format(totals.commissions)))}
${row('Net capital gain', money(totals.net), true)}
</table>`;
}

function page(title: string, subtitle: string, sections: string[]): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;padding:24px">
<h1 style="margin:0 0 4px;font-size:20px">${escapeHtml(title)}</h1>
<div style="color:${MUTED};font-size:13px;margin-bottom:16px">${escapeHtml(subtitle)}</div>
${sections.join('\n')}
<div style="color:${MUTED};font-size:12px;margin-top:24px;border-top:1px solid ${BORDER};padding-top:12px">
Gross gain per trade is (sell − buy) × quantity for one closed grid lot. Commissions are every fill in the period, including buys for lots still held. Net = gross − commissions. Times are ET.
</div>
</div></body></html>`;
}

function section(heading: string, body: string): string {
  return `<h2 style="font-size:15px;margin:20px 0 8px">${escapeHtml(heading)}</h2>${body}`;
}

function note(text: string): string {
  return `<p style="color:${MUTED};font-size:14px;margin:8px 0">${escapeHtml(text)}</p>`;
}

// --- Plain-text building blocks ------------------------------------------

function textTotals(totals: PnlTotals): string[] {
  return [
    `Trades closed:                ${totals.trades}`,
    `Gross capital gain:           ${signedUsd(totals.gross)}`,
    `Commissions paid (all fills): ${usd.format(totals.commissions)}`,
    `Net capital gain:             ${signedUsd(totals.net)}`,
  ];
}

// --- Emails --------------------------------------------------------------

export function renderDaily(
  summary: DailyPnl,
  account: EmailAccount,
  options: RenderOptions = {},
): RenderedEmail {
  // The subject names the session outright: the email lands after the close,
  // and a resend for an earlier day must not read as today's.
  const title = `Daily P&L · ${longDate(summary.date)} (session close)`;
  const subject =
    `${subjectTag(account, options)} ${title}: ` +
    `${signedUsd(summary.totals.net)} (${tradeCount(summary.totals.trades)})`;

  const tradeRows = summary.trades.map((t) => [
    escapeHtml(t.symbol),
    escapeHtml(etTimeOn(t.openedAt, summary.date)),
    escapeHtml(etTime(t.closedAt)),
    String(t.quantity),
    escapeHtml(price(t.buyPrice)),
    escapeHtml(price(t.sellPrice)),
    money(t.gain),
  ]);

  const tradesHtml =
    summary.trades.length === 0
      ? note('No trades closed today.')
      : table(['Symbol', 'Bought', 'Sold', 'Qty', 'Buy', 'Sell', 'Gain'], tradeRows, 3);

  const heldHtml =
    summary.held.length === 0
      ? note('No lots held.')
      : table(
          ['Symbol', 'Strategy', 'Lots', 'Quantity'],
          summary.held.map((h) => [
            escapeHtml(h.symbol),
            escapeHtml(h.strategyId),
            String(h.lots),
            String(h.quantity),
          ]),
          2,
        );

  const mtd = summary.monthToDate;
  const mtdHtml = note(
    `${tradeCount(mtd.trades)} · gross ${signedUsd(mtd.gross)} · ` +
      `commissions ${usd.format(mtd.commissions)} · net ${signedUsd(mtd.net)}`,
  );

  const html = page(
    title,
    `${account.alias} · ${account.mode} · trades closed ${summary.date} ET`,
    [
      section('Summary', totalsBlock(summary.totals)),
      section('Trades', tradesHtml),
      section('Month to date', mtdHtml),
      section('Currently held', heldHtml),
    ],
  );

  const text = [
    `${title} — ${account.alias} · ${account.mode}`,
    '',
    ...textTotals(summary.totals),
    '',
    'Trades',
    ...(summary.trades.length === 0
      ? ['  No trades closed today.']
      : summary.trades.map(
          (t) =>
            `  ${t.symbol} ${etTimeOn(t.openedAt, summary.date)} → ${etTime(t.closedAt)} ${t.quantity} sh ` +
            `buy ${price(t.buyPrice)} sell ${price(t.sellPrice)} gain ${signedUsd(t.gain)}`,
        )),
    '',
    `Month to date: ${tradeCount(mtd.trades)}, gross ${signedUsd(mtd.gross)}, ` +
      `commissions ${usd.format(mtd.commissions)}, net ${signedUsd(mtd.net)}`,
    '',
    'Currently held',
    ...(summary.held.length === 0
      ? ['  No lots held.']
      : summary.held.map(
          (h) => `  ${h.symbol} (${h.strategyId}): ${h.lots} lots, ${h.quantity} sh`,
        )),
    '',
    'Times are ET. Commissions include buys for lots still held.',
  ].join('\n');

  return { subject, html, text };
}

export function renderPeriod(
  summary: PeriodPnl,
  account: EmailAccount,
  options: RenderOptions = {},
): RenderedEmail {
  const range = dateRange(summary.from, summary.to);
  const title = options.periodLabel
    ? `P&L · ${options.periodLabel} (${range})`
    : `Monthly P&L · ${DateTime.fromISO(summary.from, { zone: ET_ZONE }).toFormat('LLLL yyyy')} (${range})`;
  const subject =
    `${subjectTag(account, options)} ${title}: ` +
    `${signedUsd(summary.totals.net)} (${tradeCount(summary.totals.trades)})`;

  const daysHtml =
    summary.days.length === 0
      ? note('No trades closed in this period.')
      : table(
          ['Date', 'Trades', 'Gross', 'Commissions', 'Net'],
          summary.days.map((d) => [
            escapeHtml(DateTime.fromISO(d.date).toFormat('ccc, MMM d')),
            String(d.trades),
            money(d.gross),
            escapeHtml(usd.format(d.commissions)),
            money(d.net),
          ]),
          1,
        );

  const strategyHtml =
    summary.byStrategy.length === 0
      ? note('—')
      : table(
          ['Symbol', 'Strategy', 'Trades', 'Gross'],
          summary.byStrategy.map((s) => [
            escapeHtml(s.symbol),
            escapeHtml(s.strategyId),
            String(s.trades),
            money(s.gross),
          ]),
          2,
        );

  const html = page(
    title,
    `${account.alias} · ${account.mode} · trades closed ${summary.from} to ${summary.to} ET`,
    [
      section('Summary', totalsBlock(summary.totals)),
      section('By day', daysHtml),
      section('By strategy', strategyHtml),
    ],
  );

  const text = [
    `${title} — ${account.alias} · ${account.mode}`,
    '',
    ...textTotals(summary.totals),
    '',
    'By day',
    ...(summary.days.length === 0
      ? ['  No trades closed in this period.']
      : summary.days.map(
          (d) =>
            `  ${d.date}  ${tradeCount(d.trades)}, gross ${signedUsd(d.gross)}, ` +
            `commissions ${usd.format(d.commissions)}, net ${signedUsd(d.net)}`,
        )),
    '',
    'By strategy',
    ...summary.byStrategy.map(
      (s) =>
        `  ${s.symbol} (${s.strategyId}): ${tradeCount(s.trades)}, gross ${signedUsd(s.gross)}`,
    ),
  ].join('\n');

  return { subject, html, text };
}
