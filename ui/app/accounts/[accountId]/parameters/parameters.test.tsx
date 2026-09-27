/**
 * Parameters tab tests.
 *
 * The editor's own behaviour — percent conversion, the absent `symbolCapital`
 * field, refusal reasons — is covered by `ParameterEditor.test.tsx`. What this
 * page owes is that the editor is reached with accurate inputs, in particular
 * the held-lot count, which is how the "future rungs only" rule is stated to an
 * operator before they commit an edit.
 */

import { render, screen, within } from '@testing-library/react';
import ParametersPage from './page';
import { loadParameters, type GridLot, type Lot, type ParametersData } from '../../../lib/api';

jest.mock('../../../lib/api', () => {
  const actual = jest.requireActual('../../../lib/api');
  return { ...actual, loadParameters: jest.fn() };
});

jest.mock('../../../actions', () => ({
  editParameters: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));

const mockLoad = loadParameters as jest.MockedFunction<typeof loadParameters>;

/** The route params Next.js hands the page, as a Promise (App Router, Next 15). */
const inAccount = { params: Promise.resolve({ accountId: 'nuuixl118' }) };

function lot(id: string, status: Lot['status']): Lot {
  return {
    id,
    symbol: 'TQQQ',
    rungPrice: 95,
    fillPrice: 95,
    quantity: 10,
    openedAt: '2024-03-04T09:50:00-05:00',
    exitTarget: 99.75,
    status,
    closedAt: null,
    exitPrice: null,
    realized: null,
  };
}

function gridLot(id: string, status: GridLot['status']): GridLot {
  return {
    id,
    symbol: 'TQQQ',
    fillPrice: 100,
    quantity: 50,
    openedAt: '2024-03-04T09:50:00-05:00',
    exitTarget: 101,
    status,
    closedAt: null,
    exitPrice: null,
    realized: null,
    workingOrderId: null,
  };
}

const LADDER_SET = {
  strategyId: 'dip-ladder:TQQQ',
  symbol: 'TQQQ',
  parameters: {
    // A valid `SpacingMode` and a positive floor fraction: this fixture
    // previously carried 'PERCENT' and a negative floor, neither of which the
    // backend would accept.
    spacingMode: 'PERCENTAGE' as const,
    spacingPercent: 0.03,
    spacingDollars: 1,
    takeProfitPercent: 0.05,
    takeProfitDollars: null,
    sizePerRung: 0.2,
    fixedQuantity: null,
    hardFloorPercent: 0.25,
    maxConcurrentRungs: 5,
    escalationFactor: 1,
    atrMultiple: 1,
    atrPeriod: 14,
    exitMode: 'PER_LOT' as const,
  },
};

const GRID_SET = {
  strategyId: 'grid:TQQQ',
  symbol: 'TQQQ',
  parameters: { gap: 0.5, quantity: 50, maxBuyLevels: 2, maxSellOrders: 2 },
};

function parametersData(overrides: Partial<ParametersData> = {}): ParametersData {
  return {
    parameters: [LADDER_SET],
    parameterChanges: [],
    riskLimits: {},
    riskLimitChanges: [],
    lots: [],
    gridLots: [],
    error: null,
    ...overrides,
  };
}

describe('Parameters page', () => {
  it('renders an editor per strategy', async () => {
    mockLoad.mockResolvedValue(parametersData());

    render(await ParametersPage(inAccount));

    expect(screen.getByRole('region', { name: /parameter editor/i })).toBeInTheDocument();
  });

  it('counts only held lots as keeping their targets', async () => {
    mockLoad.mockResolvedValue(
      parametersData({ lots: [lot('a', 'HELD'), lot('b', 'HELD'), lot('c', 'CLOSED')] }),
    );

    render(await ParametersPage(inAccount));

    // Closed lots have no target left to freeze.
    expect(screen.getByTestId('frozen-lot-notice')).toHaveTextContent('2 held lots');
  });

  it('states that edits reach future rungs only', async () => {
    mockLoad.mockResolvedValue(parametersData());

    render(await ParametersPage(inAccount));

    // The editor repeats this beside its submit button, so match the page's own
    // statement of the rule rather than either copy in isolation.
    expect(screen.getAllByText(/future rungs only/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/frozen at the parameters in force when it filled/i),
    ).toBeInTheDocument();
  });

  it('reports a failed load instead of rendering an empty form', async () => {
    mockLoad.mockResolvedValue(parametersData({ parameters: [], error: 'fetch failed' }));

    render(await ParametersPage(inAccount));

    expect(screen.getByRole('alert')).toHaveTextContent(/fetch failed/i);
    expect(screen.queryByRole('region', { name: /parameter editor/i })).not.toBeInTheDocument();
  });

  /**
   * Both strategies' parameters are always present in `GET /parameters`
   * regardless of which is enabled (`ParametersController`'s own doc
   * comment), so this page must dispatch each entry to the right editor by
   * strategy id — never render the grid's four fields inside the ladder's
   * form, or vice versa.
   */
  describe('a grid strategy entry', () => {
    it('renders the grid editor rather than the ladder one for a grid: id', async () => {
      mockLoad.mockResolvedValue(parametersData({ parameters: [GRID_SET] }));

      render(await ParametersPage(inAccount));

      const editor = screen.getByRole('region', { name: /parameter editor/i });
      expect(within(editor).getByLabelText('Gap ($)')).toBeInTheDocument();
      expect(within(editor).queryByLabelText('Spacing mode')).not.toBeInTheDocument();
    });

    it('counts the grid strategy’s own held lots, not the ladder’s', async () => {
      mockLoad.mockResolvedValue(
        parametersData({
          parameters: [GRID_SET],
          // The ladder's lots must not leak into the grid editor's count.
          lots: [lot('a', 'HELD'), lot('b', 'HELD')],
          gridLots: [gridLot('TQQQ-grid-lot-1', 'HELD')],
        }),
      );

      render(await ParametersPage(inAccount));

      expect(screen.getByTestId('frozen-lot-notice')).toHaveTextContent('1 held lot ');
    });

    it('renders both strategies’ editors side by side, each with its own held-lot count', async () => {
      mockLoad.mockResolvedValue(
        parametersData({
          parameters: [LADDER_SET, GRID_SET],
          lots: [lot('a', 'HELD')],
          gridLots: [gridLot('TQQQ-grid-lot-1', 'HELD'), gridLot('TQQQ-grid-lot-2', 'HELD')],
        }),
      );

      render(await ParametersPage(inAccount));

      const editors = screen.getAllByRole('region', { name: /parameter editor/i });
      expect(editors).toHaveLength(2);

      const notices = screen.getAllByTestId('frozen-lot-notice');
      expect(notices.map((n) => n.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('1 held lot '),
          expect.stringContaining('2 held lots'),
        ]),
      );
    });
  });

  it('loads the account named in the route, and no other', async () => {
    mockLoad.mockClear();
    mockLoad.mockResolvedValue(parametersData());

    // Next.js passes the segment URL-encoded; the loader must get the alias.
    render(await ParametersPage({ params: Promise.resolve({ accountId: 'paper%20two' }) }));

    expect(mockLoad).toHaveBeenCalledWith('paper two');
  });
});
