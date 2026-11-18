// Migration điền `listings.content_source` cho dữ liệu cũ (#399): chạy đúng câu SQL của file trên hai bảng tạm cùng cột,
// để không đụng dữ liệu của file test khác đang chạy song song.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const FILE = readdirSync(DIR).find((f) => f.endsWith('_nguon-noi-dung-listing-du-lieu.sql'));

type Step = [from: string | null, to: string, action: string];
interface Listing {
  key: string;
  replaces?: string;
  steps: Step[];
}

async function migrate(rows: Listing[], runs = 1): Promise<Record<string, string>> {
  const ids = new Map(rows.map((r) => [r.key, randomUUID()]));
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `create temp table t_listings (id uuid primary key, replaces_listing_id uuid, content_source text not null default 'platform') on commit drop`,
    );
    await client.query(
      `create temp table t_transitions (id bigint generated always as identity, entity_type text not null, entity_id uuid not null,
         from_state text, to_state text not null, action text not null) on commit drop`,
    );
    for (const r of rows) {
      await client.query('insert into t_listings (id, replaces_listing_id) values ($1, $2)', [ids.get(r.key), r.replaces ? ids.get(r.replaces) : null]);
      for (const [from, to, action] of r.steps) {
        await client.query(`insert into t_transitions (entity_type, entity_id, from_state, to_state, action) values ('listings', $1, $2, $3, $4)`, [
          ids.get(r.key),
          from,
          to,
          action,
        ]);
      }
    }
    // Dòng của bảng khác cùng mã không được tính.
    await client.query(`insert into t_transitions (entity_type, entity_id, from_state, to_state, action) values ('shops', $1, null, 'connecting', 'push')`, [
      ids.get('noHistory'),
    ]);
    const sql = readFileSync(join(DIR, FILE!), 'utf8').replaceAll('"channel"."listings"', 't_listings').replaceAll('"core"."state_transitions"', 't_transitions');
    expect(sql).not.toMatch(/"channel"|"core"/);
    for (let i = 0; i < runs; i++) await client.query(sql);
    const { rows: out } = await client.query<{ id: string; content_source: string }>('select id, content_source from t_listings');
    await client.query('rollback');
    const byId = new Map(out.map((r) => [r.id, r.content_source]));
    return Object.fromEntries(rows.map((r) => [r.key, byId.get(ids.get(r.key)!)!]));
  } finally {
    client.release();
  }
}

const pushed: Step[] = [
  [null, 'pushing', 'push'],
  ['pushing', 'live', 'go_live'],
  ['live', 'delisted', 'delist'],
];
const rows: Listing[] = [
  { key: 'pushed', steps: [[null, 'pushing', 'push'], ['pushing', 'under_review', 'send_review']] },
  { key: 'matched', steps: [[null, 'live', 'match']] },
  { key: 'setupMatched', steps: [[null, 'live', 'match'], ['live', 'live', 'reject_mapping']] },
  { key: 'unmanagedRequest', steps: [[null, 'live', 'request_mapping']] },
  // Chuỗi gỡ → đẩy lại → gỡ do ngắt → nối lại: theo bản đầu.
  { key: 'appRoot', steps: pushed },
  { key: 'appRepush', replaces: 'appRoot', steps: [[null, 'pushing', 'push'], ['pushing', 'live', 'go_live'], ['live', 'delisted', 'delist']] },
  { key: 'appRelist', replaces: 'appRepush', steps: [[null, 'live', 'relist']] },
  { key: 'matchRoot', steps: [[null, 'live', 'match'], ['live', 'delisted', 'delist']] },
  { key: 'matchRepush', replaces: 'matchRoot', steps: [[null, 'pushing', 'push'], ['pushing', 'live', 'go_live'], ['live', 'delisted', 'delist']] },
  { key: 'matchRepush2', replaces: 'matchRepush', steps: [[null, 'pushing', 'push']] },
  // Dùng lại listing lỗi đẩy (#346): gắn SKU sàn có sẵn → của người bán; kể cả bản đẩy lại sau đó.
  { key: 'reused', steps: [[null, 'pushing', 'push'], ['pushing', 'push_failed', 'fail'], ['push_failed', 'live', 'match'], ['live', 'delisted', 'delist']] },
  { key: 'reusedRepush', replaces: 'reused', steps: [[null, 'pushing', 'push']] },
  { key: 'approvedReuse', steps: [[null, 'pushing', 'push'], ['pushing', 'push_failed', 'fail'], ['push_failed', 'push_failed', 'request_mapping'], ['push_failed', 'live', 'approve_mapping']] },
  // Đẩy lỗi rồi đẩy lại (không ghép) vẫn là của app; đổi ghép listing đang bán không đổi chủ nội dung.
  { key: 'retried', steps: [[null, 'pushing', 'push'], ['pushing', 'push_failed', 'fail'], ['push_failed', 'pushing', 'push'], ['pushing', 'live', 'go_live']] },
  { key: 'remapped', steps: [[null, 'pushing', 'push'], ['pushing', 'live', 'go_live'], ['live', 'live', 'match']] },
  { key: 'noHistory', steps: [] },
];
const expected = {
  pushed: 'app',
  matched: 'platform',
  setupMatched: 'platform',
  unmanagedRequest: 'platform',
  appRoot: 'app',
  appRepush: 'app',
  appRelist: 'app',
  matchRoot: 'platform',
  matchRepush: 'platform',
  matchRepush2: 'platform',
  reused: 'platform',
  reusedRepush: 'platform',
  approvedReuse: 'platform',
  retried: 'app',
  remapped: 'app',
  noHistory: 'platform',
};

describe('migration điền content_source của listing (#399)', () => {
  it('có file migration dữ liệu', () => {
    expect(FILE).toBeDefined();
  });

  it('gốc chuỗi `replaces_listing_id` đẩy tạo → `app`; ghép tay, ghép thiết lập, xin "không quản tồn", không lịch sử → `platform`; dùng lại listing lỗi → `platform`', async () => {
    expect(await migrate(rows)).toEqual(expected);
  });

  it('chạy lại lần hai cho cùng kết quả', async () => {
    expect(await migrate(rows, 2)).toEqual(expected);
  });
});
