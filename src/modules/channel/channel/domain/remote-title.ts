// Cờ "Tên trên sàn đã đổi" (#396; Documents/21 §18.3 `remoteTitleChanged`): hàm thuần, không I/O. Mốc là tên trên sàn lúc
// ghép (`remote_title_at_match`, tiếng Anh `remote_title_en_at_match`); câu cập nhật cờ ở `repository/remote-skus.ts`.

/** Cột mốc tên của listing. */
export interface TitleBaseline {
  remoteTitleAtMatch: string | null;
  remoteTitleEnAtMatch: string | null;
  remoteTitleMatchedAt: Date | null;
  remoteTitleChangedAt: Date | null;
}

/** Tên của SKU trong bản sao (`remote_skus.title`, `title_en`). */
export interface SnapshotTitle {
  title: string;
  titleEn: string | null;
}

export interface RemoteTitleChanged {
  /** Tên lúc ghép (hoặc lần app đẩy, lần xác nhận gần nhất). */
  from: string;
  /** Tên trong bản sao hiện tại. */
  to: string;
  fromEn: string | null;
  toEn: string | null;
  detectedAt: Date;
}

/**
 * Cờ tính lúc đọc: listing chưa gỡ có `changed_at` và SKU còn trong bản sao. SKU đã rời bản sao thì không có tên hiện tại
 * để hiện hay để xác nhận: null.
 */
export function remoteTitleChanged(
  l: Pick<TitleBaseline, 'remoteTitleAtMatch' | 'remoteTitleEnAtMatch' | 'remoteTitleChangedAt'> & { status: string },
  r: SnapshotTitle | undefined,
): RemoteTitleChanged | null {
  if (l.status === 'delisted' || !l.remoteTitleChangedAt || l.remoteTitleAtMatch === null || !r) return null;
  return { from: l.remoteTitleAtMatch, to: r.title, fromEn: l.remoteTitleEnAtMatch, toEn: r.titleEn, detectedAt: l.remoteTitleChangedAt };
}

/**
 * Mốc lấy từ bản sao (ghép có hiệu lực, thiết lập, xác nhận). `matched_at` null: lần ghi bản sao kế tiếp lấy lại tên tiếng
 * Anh làm mốc (dòng bản sao có trước #396 chưa có `title_en`). SKU vắng bản sao: không có mốc.
 */
export function snapshotBaseline(r: SnapshotTitle | undefined): TitleBaseline {
  return { remoteTitleAtMatch: r?.title ?? null, remoteTitleEnAtMatch: r?.titleEn ?? null, remoteTitleMatchedAt: null, remoteTitleChangedAt: null };
}

/**
 * Mốc sau khi app ghi tên lên sàn (đẩy, sửa nội dung): tên app vừa gửi; app không gửi tên tiếng Anh nên giữ tên tiếng Anh
 * của bản sao. `matched_at` = lúc ghi: lượt đọc bản sao bắt đầu trước đó còn tên cũ, không được so.
 */
export function sentBaseline(name: string, r: Pick<SnapshotTitle, 'titleEn'> | undefined, at: Date): TitleBaseline {
  return { remoteTitleAtMatch: name, remoteTitleEnAtMatch: r?.titleEn ?? null, remoteTitleMatchedAt: at, remoteTitleChangedAt: null };
}
