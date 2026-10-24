import { revalidatePath } from 'next/cache';
import { post } from '../../../lib/api';
import { wheelAction } from './actions';
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('../../../lib/api', () => ({ post: jest.fn() }));
const send = post as jest.MockedFunction<typeof post>;
beforeEach(() => {
  jest.clearAllMocks();
  send.mockResolvedValue({ ok: true, status: 201, data: {}, error: null });
});
it('never defaults a missing account', async () => {
  expect((await wheelAction(null, 'enable')).ok).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
it('sends an account-scoped enable and refreshes the wheel page', async () => {
  expect((await wheelAction('paper', 'enable')).ok).toBe(true);
  expect(send).toHaveBeenCalledWith('paper', '/wheel/enable', {});
  expect(revalidatePath).toHaveBeenCalledWith('/accounts/paper/wheel');
});
it('returns broker refusal details and does not refresh a preview', async () => {
  send.mockResolvedValue({
    ok: false,
    status: 422,
    data: null,
    error: { message: ['cash unavailable', 'try again'] },
  });
  expect((await wheelAction('paper', 'preview')).message).toBe('cash unavailable; try again');
  expect(revalidatePath).not.toHaveBeenCalled();
});
