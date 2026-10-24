import { WheelController } from './wheel.controller';
import { WheelService } from '../engine/wheel.service';
const service = {
  status: jest.fn(),
  configure: jest.fn(),
  setEnabled: jest.fn(),
  preview: jest.fn(),
  run: jest.fn(),
  reconcile: jest.fn(),
  clearHalt: jest.fn(),
};
const controller = () => new WheelController(service as unknown as WheelService);
beforeEach(() =>
  Object.values(service).forEach((fn) => fn.mockReset().mockResolvedValue({ enabled: false })),
);
it('maps explicit controls and read-only preview to the wheel runtime', async () => {
  const c = controller();
  await c.status();
  await c.configure({ symbol: 'QQQ', allocation: 160000 });
  await c.enable();
  await c.disable();
  await c.preview();
  await c.run();
  await c.reconcile({ reference: 'IB activity' });
  await c.clearHalt({ reference: 'broker recovered' });
  expect(service.setEnabled.mock.calls).toEqual([[true], [false]]);
  expect(service.configure).toHaveBeenCalledWith({ symbol: 'QQQ', allocation: 160000 });
  expect(service.reconcile).toHaveBeenCalledWith('IB activity');
  expect(service.clearHalt).toHaveBeenCalledWith('broker recovered');
});
it('reports refused controls as 422 and forwards missing references as empty', async () => {
  service.preview.mockRejectedValue(new Error('PAPER only'));
  await expect(controller().preview()).rejects.toThrow('PAPER only');
  await controller().reconcile({});
  await controller().clearHalt({});
  expect(service.reconcile).toHaveBeenCalledWith('');
  expect(service.clearHalt).toHaveBeenCalledWith('');
  service.run.mockRejectedValue('connection lost');
  await expect(controller().run()).rejects.toThrow('connection lost');
});
