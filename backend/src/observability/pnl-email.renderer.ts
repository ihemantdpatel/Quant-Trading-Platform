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
import { BasisMismatch } from './average-cost-pnl';
import { Coverage, DailyPnl, PeriodPnl, PnlTotals } from './pnl-summary';

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
  return `${n} sell${n === 1 ? '' : 's'}`;
}

/**
 * Why a figure covers less than its period, or null when it covers all of it.
 * An untracked period must never read as a quiet $0.
 */
export function coverageNote(coverage: Coverage): string | null {
  if (!coverage.tracked) {
    return 'Not tracked: no IB position snapshot exists for this period, so its realized P&L cannot be computed on an average-cost basis.';
  }
  if (coverage.partial) {
    return `Partial: average-cost tracking began ${etStamp(coverage.trackedSince!)} ET; sells before that are not included.`;
  }
  return null;
}

/** One line per snapshot whose quantity disagreed with the recorded fills. */
export function mismatchNotes(mismatches: BasisMismatch[]): string[] {
  return mismatches.map(
    (m) =>
      `${m.symbol} at ${etStamp(m.takenAt)} ET: IB held ${m.brokerQuantity} sh @ ` +
      `${m.brokerAverageCost.toFixed(4)}, recorded fills explain ${m.replayedQuantity} sh @ ` +
      `${m.replayedAverageCost.toFixed(4)} — a fill is missing (e.g. a trade placed in TWS). Our ` +
      `average and realized P&L stay off until the missing fill is recorded.`,
  );
}

function etStamp(timestamp: string): string {
  return DateTime.fromISO(timestamp, { setZone: true }).setZone(ET_ZONE).toFormat('LLL d HH:mm');
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
${row('Sells', String(totals.trades))}
${row('Gross vs. average cost', money(totals.gross))}
${row('Sell commissions', escapeHtml(usd.format(totals.commissions)))}
${row('Realized P&L', money(totals.net), true)}
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
${escapeHtml(FOOTNOTE)}
</div>
</div></body></html>`;
}

const FOOTNOTE =
  'Realized P&L uses the average-cost method: each sell realizes (sell − position average cost) × quantity, ' +
  'less its commission. Buy commissions are included in the average cost. The average is our own running ' +
  "count from recorded fills, opened once from IB's position; IB's later positions are only a check, so it " +
  "can differ from IB's by cents. Times are ET.";

function section(heading: string, body: string): string {
  return `<h2 style="font-size:15px;margin:20px 0 8px">${escapeHtml(heading)}</h2>${body}`;
}

function note(text: string): string {
  return `<p style="color:${MUTED};font-size:14px;margin:8px 0">${escapeHtml(text)}</p>`;
}

function warning(text: string): string {
  return `<p style="color:${LOSS};font-size:14px;margin:8px 0">${escapeHtml(text)}</p>`;
}

function warnings(coverage: Coverage, mismatches: BasisMismatch[]): string[] {
  const coverageText = coverageNote(coverage);
  return [...(coverageText === null ? [] : [coverageText]), ...mismatchNotes(mismatches)];
}

// --- Plain-text building blocks ------------------------------------------

function textTotals(totals: PnlTotals): string[] {
  return [
    `Sells:                  ${totals.trades}`,
    `Gross vs. average cost: ${signedUsd(totals.gross)}`,
    `Sell commissions:       ${usd.format(totals.commissions)}`,
    `Realized P&L:           ${signedUsd(totals.net)}`,
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
  const headline = summary.coverage.tracked
    ? `${signedUsd(summary.totals.net)} (${tradeCount(summary.totals.trades)})`
    : 'not tracked';
  const subject = `${subjectTag(account, options)} ${title}: ${headline}`;

  const sellRows = summary.sells.map((t) => [
    escapeHtml(t.symbol),
    escapeHtml(etTime(t.timestamp)),
    String(t.quantity),
    escapeHtml(price(t.price)),
    escapeHtml(price(t.averageCost)),
    escapeHtml(usd.format(t.commission)),
    money(t.realized),
  ]);

  const sellsHtml =
    summary.sells.length === 0
      ? note('No sells today.')
      : table(['Symbol', 'Time', 'Qty', 'Sell', 'Avg cost', 'Commission', 'Realized'], sellRows, 2);

  const heldHtml =
    summary.held.length === 0
      ? note('No position held.')
      : table(
          ['Symbol', 'Quantity', 'Avg cost'],
          summary.held.map((h) => [
            escapeHtml(h.symbol),
            String(h.quantity),
            escapeHtml(price(h.averageCost)),
          ]),
          1,
        );

  const mtd = summary.monthToDate;
  const mtdNote = coverageNote(summary.monthCoverage);
  const mtdLine =
    `${tradeCount(mtd.trades)} · gross ${signedUsd(mtd.gross)} · ` +
    `commissions ${usd.format(mtd.commissions)} · realized ${signedUsd(mtd.net)}`;
  const dayWarnings = warnings(summary.coverage, summary.mismatches);

  const html = page(title, `${account.alias} · ${account.mode} · sells on ${summary.date} ET`, [
    ...dayWarnings.map(warning),
    section('Summary', totalsBlock(summary.totals)),
    section('Sells', sellsHtml),
    section('Month to date', note(mtdLine) + (mtdNote === null ? '' : note(mtdNote))),
    section('Position at close', heldHtml),
  ]);

  const text = [
    `${title} — ${account.alias} · ${account.mode}`,
    ...dayWarnings.map((w) => `! ${w}`),
    '',
    ...textTotals(summary.totals),
    '',
    'Sells',
    ...(summary.sells.length === 0
      ? ['  No sells today.']
      : summary.sells.map(
          (t) =>
            `  ${t.symbol} ${etTime(t.timestamp)} ${t.quantity} sh sell ${price(t.price)} ` +
            `avg ${price(t.averageCost)} commission ${usd.format(t.commission)} realized ${signedUsd(t.realized)}`,
        )),
    '',
    `Month to date: ${mtdLine}`,
    ...(mtdNote === null ? [] : [`  ${mtdNote}`]),
    '',
    'Position at close',
    ...(summary.held.length === 0
      ? ['  No position held.']
      : summary.held.map((h) => `  ${h.symbol}: ${h.quantity} sh @ avg ${price(h.averageCost)}`)),
    '',
    FOOTNOTE,
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
  const headline = summary.coverage.tracked
    ? `${signedUsd(summary.totals.net)} (${tradeCount(summary.totals.trades)})`
    : 'not tracked';
  const subject = `${subjectTag(account, options)} ${title}: ${headline}`;

  const daysHtml =
    summary.days.length === 0
      ? note('No sells in this period.')
      : table(
          ['Date', 'Sells', 'Gross', 'Commissions', 'Realized'],
          summary.days.map((d) => [
            escapeHtml(DateTime.fromISO(d.date).toFormat('ccc, MMM d')),
            String(d.trades),
            money(d.gross),
            escapeHtml(usd.format(d.commissions)),
            money(d.net),
          ]),
          1,
        );

  const symbolHtml =
    summary.bySymbol.length === 0
      ? note('—')
      : table(
          ['Symbol', 'Sells', 'Realized'],
          summary.bySymbol.map((s) => [escapeHtml(s.symbol), String(s.trades), money(s.net)]),
          1,
        );

  const periodWarnings = warnings(summary.coverage, summary.mismatches);

  const html = page(
    title,
    `${account.alias} · ${account.mode} · sells ${summary.from} to ${summary.to} ET`,
    [
      ...periodWarnings.map(warning),
      section('Summary', totalsBlock(summary.totals)),
      section('By day', daysHtml),
      section('By symbol', symbolHtml),
    ],
  );

  const text = [
    `${title} — ${account.alias} · ${account.mode}`,
    ...periodWarnings.map((w) => `! ${w}`),
    '',
    ...textTotals(summary.totals),
    '',
    'By day',
    ...(summary.days.length === 0
      ? ['  No sells in this period.']
      : summary.days.map(
          (d) =>
            `  ${d.date}  ${tradeCount(d.trades)}, gross ${signedUsd(d.gross)}, ` +
            `commissions ${usd.format(d.commissions)}, realized ${signedUsd(d.net)}`,
        )),
    '',
    'By symbol',
    ...summary.bySymbol.map(
      (s) => `  ${s.symbol}: ${tradeCount(s.trades)}, realized ${signedUsd(s.net)}`,
    ),
  ].join('\n');

  return { subject, html, text };
}
