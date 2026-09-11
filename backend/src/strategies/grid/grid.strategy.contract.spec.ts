import { runStrategyContractSuite } from '../contract-test-suite';
import { buildGridConfig } from './config';
import { GridStrategy } from './grid.strategy';

runStrategyContractSuite({
  name: 'GridStrategy',
  create: () => new GridStrategy(buildGridConfig('TQQQ')),
});
