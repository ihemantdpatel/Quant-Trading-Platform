/**
 * Kill switch component tests (`stories.md:465`).
 *
 * The kill switch is the control an operator reaches for when something is
 * wrong. These tests assert it is present and legible in both states, and that
 * clicking it calls through to the backend action rather than only changing
 * local state — a switch that looked engaged without halting anything is the
 * worst possible failure of this component.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KillSwitch } from './KillSwitch';

const setKillSwitch = jest.fn();

jest.mock('../actions', () => ({
  setKillSwitch: (...args: unknown[]) => setKillSwitch(...args),
}));

beforeEach(() => {
  setKillSwitch.mockReset();
  setKillSwitch.mockResolvedValue({ ok: true, message: 'done' });
});

describe('KillSwitch', () => {
  it('renders in the armed state with an engage control', () => {
    render(<KillSwitch engaged={false} reason={null} changedAt={null} />);

    expect(screen.getByTestId('kill-switch-state')).toHaveTextContent('ARMED');
    expect(screen.getByRole('button', { name: /engage kill switch/i })).toBeInTheDocument();
  });

  it('renders the engaged state and says submission is halted', () => {
    render(<KillSwitch engaged reason="operator action" changedAt="2024-03-04T10:00:00-05:00" />);

    expect(screen.getByTestId('kill-switch-state')).toHaveTextContent('ENGAGED');
    expect(screen.getByText(/all new order submission is halted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /release/i })).toBeInTheDocument();
  });

  it('engages through the backend action when clicked', async () => {
    const user = userEvent.setup();
    render(<KillSwitch engaged={false} reason={null} changedAt={null} />);

    await user.click(screen.getByRole('button', { name: /engage kill switch/i }));

    expect(setKillSwitch).toHaveBeenCalledWith(true, '');
  });

  it('passes the operator reason through to the backend', async () => {
    const user = userEvent.setup();
    render(<KillSwitch engaged={false} reason={null} changedAt={null} />);

    await user.type(screen.getByLabelText(/kill switch reason/i), 'runaway ladder');
    await user.click(screen.getByRole('button', { name: /engage kill switch/i }));

    expect(setKillSwitch).toHaveBeenCalledWith(true, 'runaway ladder');
  });

  it('releases when already engaged', async () => {
    const user = userEvent.setup();
    render(<KillSwitch engaged reason="halted" changedAt={null} />);

    await user.click(screen.getByRole('button', { name: /release/i }));

    expect(setKillSwitch).toHaveBeenCalledWith(false, '');
  });

  it('surfaces a failure from the backend rather than reporting success', async () => {
    setKillSwitch.mockResolvedValue({ ok: false, message: 'the engine could not be reached' });
    const user = userEvent.setup();
    render(<KillSwitch engaged={false} reason={null} changedAt={null} />);

    await user.click(screen.getByRole('button', { name: /engage kill switch/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/could not be reached/i);
    // And it must not claim to be engaged: state comes from the server prop.
    expect(screen.getByTestId('kill-switch-state')).toHaveTextContent('ARMED');
  });

  it('shows the last recorded change', () => {
    render(<KillSwitch engaged reason="broker fault" changedAt="2024-03-04T10:00:00-05:00" />);

    expect(screen.getByText(/broker fault/)).toBeInTheDocument();
  });
});
