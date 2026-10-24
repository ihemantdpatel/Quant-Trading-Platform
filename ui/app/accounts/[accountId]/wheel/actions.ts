'use server';

import { revalidatePath } from 'next/cache';
import { post } from '../../../lib/api';

const actions = [
  'configure',
  'enable',
  'disable',
  'preview',
  'run',
  'reconcile',
  'clear-halt',
] as const;
export type WheelAction = (typeof actions)[number];

export async function wheelAction(
  account: string | null,
  action: WheelAction,
  input: unknown = {},
) {
  if (!account || !actions.includes(action))
    return { ok: false, data: null, message: 'Select an account and a valid wheel action.' };
  const result = await post<unknown>(account, `/wheel/${action}`, input);
  if (action !== 'preview') revalidatePath(`/accounts/${encodeURIComponent(account)}/wheel`);
  const body = result.error as { message?: string | string[] } | null;
  return {
    ok: result.ok,
    data: result.data,
    message: result.ok
      ? `${action} completed`
      : Array.isArray(body?.message)
        ? body.message.join('; ')
        : (body?.message ?? 'The wheel request failed.'),
  };
}
