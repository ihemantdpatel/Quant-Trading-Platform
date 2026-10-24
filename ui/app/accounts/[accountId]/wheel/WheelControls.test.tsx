import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WheelControls } from './WheelControls';
import { wheelAction } from './actions';
import type { WheelState } from '../../../lib/api';

jest.mock('./actions', () => ({ wheelAction: jest.fn() }));
jest.mock('../../../components/AccountContext', () => ({ useAccount: () => 'paper-grid' }));
const action = wheelAction as jest.MockedFunction<typeof wheelAction>;
const state: WheelState = {
  config: null,
  enabled: false,
  halt: null,
  shares: 0,
  stockCost: 0,
  orders: [],
  audit: [],
};
beforeEach(() => action.mockReset().mockResolvedValue({ ok: true, data: null, message: 'Saved' }));

it('defaults to the requested QQQ allocation and saves without enabling', async () => {
  render(<WheelControls state={state} />);
  expect(screen.getByLabelText('Ticker')).toHaveValue('QQQ');
  expect(screen.getByLabelText('Maximum allocation (USD)')).toHaveValue(160000);
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith('paper-grid', 'configure', {
      symbol: 'QQQ',
      allocation: 160000,
      maxContracts: 1,
    }),
  );
  expect(action).toHaveBeenCalledTimes(1);
});
it('previews full contract details without requesting a trade', async () => {
  action.mockResolvedValue({
    ok: true,
    message: 'preview completed',
    data: {
      intents: [
        {
          quantity: 1,
          limitPrice: 2,
          contract: { symbol: 'QQQ', expiry: '2026-11-20', strike: 500, right: 'P' },
        },
      ],
    },
  });
  render(<WheelControls state={{ ...state, config: { symbol: 'QQQ', allocation: 160000 } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview next order' }));
  expect(await screen.findByText(/Sell 1 QQQ 2026-11-20 \$500 put/)).toBeInTheDocument();
  expect(action).toHaveBeenCalledWith('paper-grid', 'preview', {});
});
it('shows a declined request and keeps unavailable controls disabled', async () => {
  action.mockResolvedValue({ ok: false, data: null, message: 'Insufficient cash' });
  const view = render(
    <WheelControls state={{ ...state, config: { symbol: 'QQQ', allocation: 160000 } }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview next order' }));
  expect(await screen.findByText('Insufficient cash')).toBeInTheDocument();
  view.rerender(<WheelControls state={null} />);
  expect(screen.getByRole('button', { name: 'Enable paper wheel' })).toBeDisabled();
});
it('requires a broker reference before lifecycle confirmation and scopes it to the displayed account', async () => {
  render(
    <WheelControls
      state={{
        ...state,
        config: { symbol: 'QQQ', allocation: 160000 },
        halt: 'assignment needs verification',
      }}
    />,
  );
  const button = screen.getByRole('button', { name: 'Confirm lifecycle and reconcile' });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Broker activity reference and reason'), {
    target: { value: 'IB statement confirms assignment' },
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith('paper-grid', 'reconcile', {
      reference: 'IB statement confirms assignment',
    }),
  );
});
it('enables and disables explicitly, leaving config and existing orders separate', async () => {
  const view = render(
    <WheelControls state={{ ...state, config: { symbol: 'QQQ', allocation: 160000 } }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enable paper wheel' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('paper-grid', 'enable', {}));
  await screen.findByText('Saved');
  view.rerender(<WheelControls state={{ ...state, enabled: true }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Disable new orders' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('paper-grid', 'disable', {}));
});
