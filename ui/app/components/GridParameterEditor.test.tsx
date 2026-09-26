/**
 * Grid parameter editor tests — the grid counterpart to
 * `ParameterEditor.test.tsx`.
 *
 * The editor must communicate the rule it operates under: edits reach future
 * buy levels and future lots only, never a lot already held. Enforcement
 * itself lives in the backend (`GridParameterService`,
 * `EDITABLE_GRID_PARAMETERS`); this only has to say so and to submit exactly
 * the four editable fields.
 */

import { render as rtlRender, screen } from '@testing-library/react';
import { AccountProvider } from './AccountContext';
import userEvent from '@testing-library/user-event';
import { GridParameterEditor } from './GridParameterEditor';
import type { GridParameters } from '../lib/api';

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

const PARAMETERS: GridParameters = {
  gap: 0.5,
  quantity: 50,
  maxBuyLevels: 2,
  maxSellOrders: 2,
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
    <GridParameterEditor
      strategyId="grid:TQQQ"
      parameters={PARAMETERS}
      heldLotCount={heldLotCount}
      changes={[]}
    />,
  );
}

describe('GridParameterEditor', () => {
  it('states that edits apply to future buy levels and future lots only', () => {
    renderEditor();

    expect(screen.getByText(/future buy levels and future lots only/i)).toBeInTheDocument();
    expect(
      screen.getByText(/held lots keep the sell targets they filled with/i),
    ).toBeInTheDocument();
  });

  it('names how many held lots keep their existing sell targets', () => {
    renderEditor(3);

    expect(screen.getByTestId('frozen-lot-notice')).toHaveTextContent(
      /3 held lots keep existing targets/i,
    );
  });

  it('renders the four editable grid fields with their current values', () => {
    renderEditor();

    expect(screen.getByLabelText('Gap ($)')).toHaveValue(0.5);
    expect(screen.getByLabelText('Quantity')).toHaveValue(50);
    expect(screen.getByLabelText('Max buy levels')).toHaveValue(2);
    expect(screen.getByLabelText('Max sell orders')).toHaveValue(2);
  });

  it('submits exactly the four editable fields', async () => {
    const user = userEvent.setup();
    renderEditor();

    const gap = screen.getByLabelText('Gap ($)');
    await user.clear(gap);
    await user.type(gap, '1');
    await user.click(screen.getByRole('button', { name: /apply to future levels/i }));

    expect(editParameters).toHaveBeenCalledWith(
      'nuuixl118',
      'grid:TQQQ',
      { gap: 1, quantity: 50, maxBuyLevels: 2, maxSellOrders: 2 },
      '',
    );
  });

  /**
   * The set of field names the form can actually post — asserted against
   * `name` attributes so a hint mentioning a value cannot be mistaken for a
   * submittable field.
   */
  function submittableFieldNames(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('input[name], select[name]')).map((node) =>
      node.getAttribute('name')!,
    );
  }

  it('does not expose symbol or entryBuffer, which are excluded from live edits', () => {
    const { container } = renderEditor();

    expect(submittableFieldNames(container)).not.toContain('symbol');
    expect(submittableFieldNames(container)).not.toContain('entryBuffer');
  });

  it('exposes no field that could retarget a held lot', () => {
    const { container } = renderEditor();
    const names = submittableFieldNames(container);

    for (const forbidden of ['sellTarget', 'lots', 'fillPrice', 'openedAt']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('surfaces a refusal from the backend with its reasons', async () => {
    editParameters.mockResolvedValue({
      ok: false,
      message: 'not editable at runtime: sellTarget',
      failures: ['sellTarget: full recompute is not permitted'],
    });

    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /apply to future levels/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/not editable at runtime/i);
    expect(status).toHaveTextContent(/full recompute is not permitted/i);
  });

  it('renders the append-only change log when changes exist', () => {
    render(
      <GridParameterEditor
        strategyId="grid:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[
          {
            id: 'c1:gap',
            changeId: 'c1',
            strategyId: 'grid:TQQQ',
            parameter: 'gap',
            oldValue: 0.5,
            newValue: 1,
            timestamp: '2024-03-04T10:00:00.000Z',
            reason: 'wider gap in chop',
          },
        ]}
      />,
    );

    expect(screen.getByText(/change log \(append-only\)/i)).toBeInTheDocument();
    expect(screen.getByText('gap')).toBeInTheDocument();
    expect(screen.getByText(/wider gap in chop/)).toBeInTheDocument();
  });

  it('renders the risk-limit section for the grid instance’s symbol, shared with the ladder editor', () => {
    renderEditorWithRiskLimit();

    expect(screen.getByText(/risk limit — TQQQ/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Per-symbol limit')).toHaveValue(40_000);
  });

  function renderEditorWithRiskLimit() {
    return render(
      <GridParameterEditor
        strategyId="grid:TQQQ"
        parameters={PARAMETERS}
        heldLotCount={0}
        changes={[]}
        symbol="TQQQ"
        riskLimit={40_000}
        riskLimitChanges={[]}
      />,
    );
  }

  it('submits a risk-limit edit separately from the grid parameter form', async () => {
    const user = userEvent.setup();
    renderEditorWithRiskLimit();

    const input = screen.getByLabelText('Per-symbol limit');
    await user.clear(input);
    await user.type(input, '180000');
    await user.click(screen.getByRole('button', { name: /update limit/i }));

    expect(editRiskLimit).toHaveBeenCalledWith('nuuixl118', 'TQQQ', 180_000, '');
    expect(editParameters).not.toHaveBeenCalled();
  });
});
