/**
 * Parameter editor tests.
 *
 * The editor must communicate the rule it operates under: **future rungs only**
 * (`PRD.md:386`). An operator who believes an edit retargets held lots will
 * make different decisions than one who knows it does not, so the statement is
 * part of the control, not decoration around it.
 *
 * Enforcement itself lives in the backend and is covered by
 * `parameters.integration.spec.ts` — including the refusal of any attempt to
 * retarget a filled rung.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParameterEditor } from './ParameterEditor';
import type { LadderParameters } from '../lib/api';

const editParameters = jest.fn();

jest.mock('../actions', () => ({
  editParameters: (...args: unknown[]) => editParameters(...args),
}));

const PARAMETERS: LadderParameters = {
  spacingMode: 'PERCENTAGE',
  spacingPercent: 0.05,
  atrMultiple: 1,
  atrPeriod: 14,
  takeProfitPercent: 0.05,
  exitMode: 'PER_LOT',
  sizePerRung: 0.25,
  escalationFactor: 1,
  maxConcurrentRungs: 5,
  hardFloorPercent: 0.25,
};

beforeEach(() => {
  editParameters.mockReset();
  editParameters.mockResolvedValue({ ok: true, message: '1 parameter updated.' });
});

function renderEditor(heldLotCount = 2) {
  return render(
    <ParameterEditor
      strategyId="dip-ladder:TQQQ"
      parameters={PARAMETERS}
      heldLotCount={heldLotCount}
      changes={[]}
    />,
  );
}

describe('ParameterEditor', () => {
  it('states that edits apply to future rungs only', () => {
    renderEditor();

    expect(screen.getByText(/applies to future rungs only/i)).toBeInTheDocument();
    expect(screen.getByText(/held lots keep the targets they filled with/i)).toBeInTheDocument();
  });

  it('names how many held lots keep their existing targets', () => {
    renderEditor(3);

    expect(screen.getByTestId('frozen-lot-notice')).toHaveTextContent(
      /3 held lots keep existing targets/i,
    );
  });

  it('renders percentage parameters as percentages', () => {
    renderEditor();

    expect(screen.getByLabelText(/take profit/i)).toHaveValue(5);
    expect(screen.getByLabelText(/rung spacing/i)).toHaveValue(5);
    expect(screen.getByLabelText(/hard floor/i)).toHaveValue(25);
  });

  it('submits percentages back as fractions', async () => {
    const user = userEvent.setup();
    renderEditor();

    const takeProfit = screen.getByLabelText(/take profit/i);
    await user.clear(takeProfit);
    await user.type(takeProfit, '8');
    await user.click(screen.getByRole('button', { name: /apply to future rungs/i }));

    expect(editParameters).toHaveBeenCalledWith(
      'dip-ladder:TQQQ',
      // 8% is sent as 0.08, matching `DipLadderConfig`.
      expect.objectContaining({ takeProfitPercent: 0.08 }),
      '',
    );
  });

  /**
   * The set of field names the form can actually post.
   *
   * Asserted against `name` attributes rather than labels: `name` is what is
   * submitted, and a label can mention a value in its hint text — "fraction of
   * symbol capital" — without the form being able to set that value.
   */
  function submittableFieldNames(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('input[name], select[name]')).map((node) =>
      node.getAttribute('name')!,
    );
  }

  it('does not expose symbolCapital, which is a Story 13 item', () => {
    const { container } = renderEditor();

    expect(submittableFieldNames(container)).not.toContain('symbolCapital');
    expect(submittableFieldNames(container)).not.toContain('symbol');
  });

  it('exposes no field that could retarget a held lot', () => {
    const { container } = renderEditor();
    const names = submittableFieldNames(container);

    // Every one of these is refused by the backend; none should be offered.
    for (const forbidden of [
      'exitTarget',
      'lots',
      'rungs',
      'recompute',
      'fillPrice',
      'rungPrice',
    ]) {
      expect(names).not.toContain(forbidden);
    }

    expect(screen.queryByRole('button', { name: /recompute/i })).not.toBeInTheDocument();
  });

  it('surfaces a refusal from the backend with its reasons', async () => {
    editParameters.mockResolvedValue({
      ok: false,
      message: 'not editable at runtime: exitTarget',
      failures: ['exitTarget: full recompute is not permitted'],
    });

    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /apply to future rungs/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/not editable at runtime/i);
    expect(status).toHaveTextContent(/full recompute is not permitted/i);
  });

  it('renders the append-only change log when changes exist', () => {
    render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[
          {
            id: 'c1:takeProfitPercent',
            changeId: 'c1',
            strategyId: 'dip-ladder:TQQQ',
            parameter: 'takeProfitPercent',
            oldValue: 0.05,
            newValue: 0.08,
            timestamp: '2024-03-04T10:00:00.000Z',
            reason: 'wider target in chop',
          },
        ]}
      />,
    );

    expect(screen.getByText(/change log \(append-only\)/i)).toBeInTheDocument();
    expect(screen.getByText(/takeProfitPercent/)).toBeInTheDocument();
    expect(screen.getByText(/wider target in chop/)).toBeInTheDocument();
  });
});
