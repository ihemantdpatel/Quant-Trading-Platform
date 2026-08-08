/**
 * Mode switch tests (`stories.md:467`).
 *
 * The headline case: **a switch to `PAPER` with unset parameters shows the
 * blocking reason**. Story 7 lists this as an e2e test; asserted here at the
 * component level, with the backend's own refusal covered by
 * `parameters.integration.spec.ts` and `engine.integration.spec.ts`.
 *
 * What matters is that the component renders the *specific* failures the
 * backend returned rather than a generic error — an operator needs to know
 * which value is missing, and both missing values are deliberate Story 13 items
 * rather than bugs to work around.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeSwitch } from './ModeSwitch';

const setMode = jest.fn();

jest.mock('../actions', () => ({
  setMode: (...args: unknown[]) => setMode(...args),
}));

beforeEach(() => {
  setMode.mockReset();
});

describe('ModeSwitch', () => {
  it('shows the current mode and that SHADOW submits nothing', () => {
    setMode.mockResolvedValue({ ok: true, message: 'ok' });
    render(<ModeSwitch mode="SHADOW" />);

    expect(screen.getByTestId('current-mode')).toHaveTextContent('SHADOW');
    expect(screen.getByText(/nothing is submitted/i)).toBeInTheDocument();
  });

  it('shows the blocking reasons when PAPER is refused for unset parameters', async () => {
    setMode.mockResolvedValue({
      ok: false,
      message: 'refusing to switch to PAPER',
      failures: [
        'per-symbol capital allocation is unset (PRD.md:500)',
        'daily loss threshold is unset (PRD.md:500)',
      ],
    });

    const user = userEvent.setup();
    render(<ModeSwitch mode="SHADOW" />);

    await user.click(screen.getByRole('button', { name: 'PAPER' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/refusing to switch to PAPER/i);
    expect(status).toHaveTextContent(/per-symbol capital allocation is unset/i);
    expect(status).toHaveTextContent(/daily loss threshold is unset/i);
  });

  it('stays on the current mode when the switch is refused', async () => {
    setMode.mockResolvedValue({ ok: false, message: 'refusing to switch to PAPER', failures: [] });

    const user = userEvent.setup();
    render(<ModeSwitch mode="SHADOW" />);

    await user.click(screen.getByRole('button', { name: 'PAPER' }));
    await screen.findByRole('status');

    // Mode is server state; a refused request must not make the UI claim PAPER.
    expect(screen.getByTestId('current-mode')).toHaveTextContent('SHADOW');
  });

  it('requests the mode the operator selected', async () => {
    setMode.mockResolvedValue({ ok: true, message: 'ok' });
    const user = userEvent.setup();
    render(<ModeSwitch mode="SHADOW" />);

    await user.click(screen.getByRole('button', { name: 'LIVE' }));

    expect(setMode).toHaveBeenCalledWith('LIVE');
  });

  it('disables the button for the mode already in force', () => {
    setMode.mockResolvedValue({ ok: true, message: 'ok' });
    render(<ModeSwitch mode="SHADOW" />);

    expect(screen.getByRole('button', { name: 'SHADOW' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'PAPER' })).toBeEnabled();
  });
});
