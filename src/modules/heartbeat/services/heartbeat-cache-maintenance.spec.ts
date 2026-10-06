import { DataSource } from 'typeorm';
import { Peer } from '../../../common/entities';
import * as maintenance from '../../../updater/maintenance';
import { HeartbeatCacheService } from './heartbeat-cache.service';

describe('heartbeat cache during update maintenance', () => {
  const update = {
    id: 'device',
    ver: 1,
    modifiedAt: 1,
    lastHeartbeat: new Date(),
  };

  afterEach(() => jest.restoreAllMocks());

  function fixture() {
    const manager = { update: jest.fn().mockResolvedValue(undefined) };
    const transaction = jest.fn(
      async (work: (value: unknown) => Promise<void>) => work(manager),
    );
    const service = new HeartbeatCacheService({
      transaction,
    } as unknown as DataSource);
    service.bufferPeerUpdate('device-uuid', update);
    return { service, transaction, manager };
  }

  it('keeps queued writes until maintenance allows scheduled flushing', async () => {
    const allowed = jest
      .spyOn(maintenance, 'businessWritesAllowed')
      .mockReturnValue(false);
    const { service, transaction, manager } = fixture();

    await service.handleScheduledFlush();
    expect(transaction).not.toHaveBeenCalled();

    allowed.mockReturnValue(true);
    await service.handleScheduledFlush();
    expect(manager.update).toHaveBeenCalledWith(
      Peer,
      { uuid: 'device-uuid' },
      update,
    );
  });

  it('flushes accepted writes on shutdown before the stopped-service backup', async () => {
    jest.spyOn(maintenance, 'businessWritesAllowed').mockReturnValue(false);
    const { service, manager } = fixture();

    await service.onModuleDestroy();

    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      Peer,
      { uuid: 'device-uuid' },
      update,
    );
  });
});
