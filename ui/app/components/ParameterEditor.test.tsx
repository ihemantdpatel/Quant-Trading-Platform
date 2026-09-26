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

import { render as rtlRender, screen } from '@testing-library/react';
import { AccountProvider } from './AccountContext';
import userEvent from '@testing-library/user-event';
import { ParameterEditor } from './ParameterEditor';
import type { LadderParameters } from '../lib/api';

/** Every control acts on the account of the page it is on — rendered inside one here. */
function render(ui: React.ReactElement) {
  return rtlRender(<AccountProvider account="nuuixl118">{ui}</AccountProvider>);
}

const editParameters = jest.fn();
const editRiskLimit = jest.fn();

jest.mock('../actions', () => ({
  editParameters: (...args: unknown[]) => editParameters(...args),
  editRiskLimit: (...args: unknown[]) => editRiskLimit(...args),
}));

const PARAMETERS: LadderParameters = {
  spacingMode: 'PERCENTAGE',
  spacingPercent: 0.05,
  atrMultiple: 1,
  atrPeriod: 14,
  takeProfitPercent: 0.05,
  takeProfitDollars: null,
  spacingDollars: 1,
  fixedQuantity: null,
  exitMode: 'PER_LOT',
  sizePerRung: 0.25,
  escalationFactor: 1,
  maxConcurrentRungs: 5,
  hardFloorPercent: 0.25,
};

beforeEach(() => {
  editParameters.mockReset();
  editParameters.mockResolvedValue({ ok: true, message: '1 parameter updated.' });
  editRiskLimit.mockReset();
  editRiskLimit.mockResolvedValue({
    ok: true,
    message: 'TQQQ risk limit updated: 40000 → 180000.',
  });
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

    expect(screen.getByLabelText('Take profit')).toHaveValue(5);
    expect(screen.getByLabelText('Rung spacing')).toHaveValue(5);
    expect(screen.getByLabelText(/hard floor/i)).toHaveValue(25);
  });

  it('submits percentages back as fractions', async () => {
    const user = userEvent.setup();
    renderEditor();

    const takeProfit = screen.getByLabelText('Take profit');
    await user.clear(takeProfit);
    await user.type(takeProfit, '8');
    await user.click(screen.getByRole('button', { name: /apply to future rungs/i }));

    expect(editParameters).toHaveBeenCalledWith(
      'nuuixl118',
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

/**
 * The fixed-dollar geometry the live engine runs.
 *
 * The failure this guards against is specific and was real: the form rendered a
 * hardcoded percentage field list, so an operator saw `spacingPercent` at 5%
 * while the ladder placed $1 rungs — and editing that 5% would have written an
 * audit record for a value the engine does not read.
 */
describe('ParameterEditor with fixed-dollar parameters', () => {
  const FIXED_DOLLAR: LadderParameters = {
    ...PARAMETERS,
    spacingMode: 'FIXED_DOLLAR',
    spacingDollars: 1,
    takeProfitDollars: 1,
    fixedQuantity: 50,
  };

  function renderFixedDollar() {
    return render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={FIXED_DOLLAR}
        heldLotCount={0}
        changes={[]}
      />,
    );
  }

  it('shows the absolute values the engine actually uses', () => {
    renderFixedDollar();

    expect(screen.getByLabelText('Rung spacing ($)')).toHaveValue(1);
    expect(screen.getByLabelText('Take profit ($)')).toHaveValue(1);
    expect(screen.getByLabelText('Fixed quantity')).toHaveValue(50);
  });

  it('disables the percentage fields those values supersede', () => {
    renderFixedDollar();

    expect(screen.getByLabelText('Rung spacing')).toBeDisabled();
    expect(screen.getByLabelText('Take profit')).toBeDisabled();
    expect(screen.getByLabelText('Size per rung')).toBeDisabled();
    // The floor is not superseded by anything and stays editable.
    expect(screen.getByLabelText('Hard floor')).toBeEnabled();
  });

  it('does not submit a superseded percentage, which the engine would ignore', async () => {
    const user = userEvent.setup();
    renderFixedDollar();

    await user.click(screen.getByRole('button', { name: /apply to future rungs/i }));

    const payload = editParameters.mock.calls[0][2] as Record<string, unknown>;

    expect(payload).not.toHaveProperty('spacingPercent');
    expect(payload).not.toHaveProperty('takeProfitPercent');
    expect(payload).not.toHaveProperty('sizePerRung');
    expect(payload.spacingDollars).toBe(1);
    expect(payload.takeProfitDollars).toBe(1);
    expect(payload.fixedQuantity).toBe(50);
  });

  it('sends null when an absolute field is cleared, restoring the percentage rule', async () => {
    const user = userEvent.setup();
    renderFixedDollar();

    await user.clear(screen.getByLabelText('Take profit ($)'));
    await user.clear(screen.getByLabelText('Fixed quantity'));
    await user.click(screen.getByRole('button', { name: /apply to future rungs/i }));

    const payload = editParameters.mock.calls[0][2] as Record<string, unknown>;

    // Explicitly null rather than absent: omitting the key means "leave
    // unchanged", which would make clearing the field impossible.
    expect(payload.takeProfitDollars).toBeNull();
    expect(payload.fixedQuantity).toBeNull();
  });

  it('offers FIXED_DOLLAR as a spacing mode', () => {
    renderFixedDollar();

    expect(screen.getByLabelText('Spacing mode')).toHaveValue('FIXED_DOLLAR');
  });
});

/**
 * The risk-layer per-symbol limit section — a separate control from the
 * ladder parameters above, since `RiskConfig.perSymbolLimits` is not part of
 * `DipLadderConfig` (`capital-cap.ts`).
 */
describe('ParameterEditor risk limit section', () => {
  it('renders nothing when no symbol is supplied', () => {
    render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[]}
      />,
    );

    expect(screen.queryByText(/risk limit —/i)).not.toBeInTheDocument();
  });

  it('shows the current limit for the symbol', () => {
    render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[]}
        symbol="TQQQ"
        riskLimit={40_000}
        riskLimitChanges={[]}
      />,
    );

    expect(screen.getByText(/risk limit — TQQQ/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Per-symbol limit')).toHaveValue(40_000);
  });

  it('submits an edit to the risk-limit action, separately from the ladder form', async () => {
    const user = userEvent.setup();
    render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[]}
        symbol="TQQQ"
        riskLimit={40_000}
        riskLimitChanges={[]}
      />,
    );

    const input = screen.getByLabelText('Per-symbol limit');
    await user.clear(input);
    await user.type(input, '180000');
    await user.click(screen.getByRole('button', { name: /update limit/i }));

    expect(editRiskLimit).toHaveBeenCalledWith('nuuixl118', 'TQQQ', 180_000, '');
    expect(editParameters).not.toHaveBeenCalled();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/180000/);
  });

  it('renders the append-only risk-limit change log', () => {
    render(
      <ParameterEditor
        strategyId="dip-ladder:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[]}
        symbol="TQQQ"
        riskLimit={180_000}
        riskLimitChanges={[
          {
            id: 'risk-limit-change-1',
            symbol: 'TQQQ',
            oldValue: 40_000,
            newValue: 180_000,
            timestamp: '2026-09-09T12:00:00.000Z',
            reason: 'account funded to a larger balance',
          },
        ]}
      />,
    );

    expect(screen.getByText(/account funded to a larger balance/)).toBeInTheDocument();
    expect(screen.getByText(/40000/)).toBeInTheDocument();
    expect(screen.getByText(/180000/)).toBeInTheDocument();
  });
});
