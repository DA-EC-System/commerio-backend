import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const run = promisify(execFile);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface TestKafka {
  readonly brokers: string[];
  /** Dừng broker mà giữ container (AC-3), chạy lại thì cùng cổng, cùng dữ liệu. */
  pause(): Promise<void>;
  unpause(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Kafka riêng cho một file test, cùng ảnh và cấu hình KRaft với deploy/compose.yaml. Cổng host cố định (lấy cổng
 * trống) vì broker phải quảng bá đúng địa chỉ máy test, và để `docker stop`/`start` giữ nguyên địa chỉ.
 * `@testcontainers/kafka` chỉ nhận ảnh confluentinc/cp-kafka nên không dùng (plan #38 A10).
 */
export async function startKafka(): Promise<TestKafka> {
  const port = await freePort();
  const container: StartedTestContainer = await new GenericContainer('apache/kafka:4.1.0')
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_NUM_PARTITIONS: '3',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(110_000)
    .start();
  const id = container.getId();
  return {
    brokers: [`127.0.0.1:${port}`],
    pause: async () => void (await run('docker', ['stop', '-t', '5', id])),
    unpause: async () => void (await run('docker', ['start', id])),
    stop: () => container.stop().then(() => undefined),
  };
}
