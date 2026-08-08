/**
 * Parameters tab tests.
 *
 * The editor's own behaviour — percent conversion, the absent `symbolCapital`
 * field, refusal reasons — is covered by `ParameterEditor.test.tsx`. What this
 * page owes is that the editor is reached with accurate inputs, in particular
 * the held-lot count, which is how the "future rungs only" rule is stated to an
 * operator before they commit an edit.
 */

import { render, screen } from '@testing-library/react';
import ParametersPage from './page';
import { loadParameters, type Lot, type ParametersData } from '../lib/api';

jest.mock('../lib/api', () => {
  const actual = jest.requireActual('../lib/api');
  return { ...actual, loadParameters: jest.fn() };
});

jest.mock('../actions', () => ({
  editParameters: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
}));

const mockLoad = loadParameters as jest.MockedFunction<typeof loadParameters>;

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

function parametersData(overrides: Partial<ParametersData> = {}): ParametersData {
  return {
    parameters: [
      {
        strategyId: 'dip-ladder:TQQQ',
        parameters: {
          spacingMode: 'PERCENT',
          spacingPercent: 0.03,
          takeProfitPercent: 0.05,
          sizePerRung: 0.2,
          hardFloorPercent: -0.25,
          maxConcurrentRungs: 5,
          escalationFactor: 1,
          atrMultiple: 1,
          atrPeriod: 14,
          symbol: 'TQQQ',
        },
      },
    ],
    parameterChanges: [],
    lots: [],
    error: null,
    ...overrides,
  };
}

describe('Parameters page', () => {
  it('renders an editor per strategy', async () => {
    mockLoad.mockResolvedValue(parametersData());

    render(await ParametersPage());

    expect(screen.getByRole('region', { name: /parameter editor/i })).toBeInTheDocument();
  });

  it('counts only held lots as keeping their targets', async () => {
    mockLoad.mockResolvedValue(
      parametersData({ lots: [lot('a', 'HELD'), lot('b', 'HELD'), lot('c', 'CLOSED')] }),
    );

    render(await ParametersPage());

    // Closed lots have no target left to freeze.
    expect(screen.getByTestId('frozen-lot-notice')).toHaveTextContent('2 held lots');
  });

  it('states that edits reach future rungs only', async () => {
    mockLoad.mockResolvedValue(parametersData());

    render(await ParametersPage());

    // The editor repeats this beside its submit button, so match the page's own
    // statement of the rule rather than either copy in isolation.
    expect(screen.getAllByText(/future rungs only/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/frozen at the parameters in force when it filled/i),
    ).toBeInTheDocument();
  });

  it('reports a failed load instead of rendering an empty form', async () => {
    mockLoad.mockResolvedValue(parametersData({ parameters: [], error: 'fetch failed' }));

    render(await ParametersPage());

    expect(screen.getByRole('alert')).toHaveTextContent(/fetch failed/i);
    expect(screen.queryByRole('region', { name: /parameter editor/i })).not.toBeInTheDocument();
  });
});
