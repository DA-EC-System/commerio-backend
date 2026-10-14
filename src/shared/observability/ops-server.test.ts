import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServer } from '../lifecycle.ts';
import { startOpsServer } from './ops-server.ts';

describe('cổng vận hành', () => {
  const server = startOpsServer(0, () => {});
  const baseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  afterAll(() => closeServer(server));

  it('trả số liệu Prometheus ở /metrics', async () => {
    await new Promise((resolve) => (server.listening ? resolve(null) : server.once('listening', resolve)));
    const res = await fetch(`${baseUrl()}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('http_request_duration_seconds');
  });
});
