// Độ tin cậy của gợi ý liên kết SKU sàn (#565, Documents/21 §18.12): trùng SKU người bán là chắc chắn (`high`, FE gom vào
// nút "Chấp nhận gợi ý chắc chắn"); giống tên (pg_trgm, nhận từ 0,4) từ 0,7 là `medium`, dưới đó `low`.

export type MatchConfidence = 'high' | 'medium' | 'low';

/** Điểm tên từ mức này trở lên là `medium`. */
export const MEDIUM_CONFIDENCE_MIN = 0.7;

/** `score` null là khớp SKU người bán. */
export function confidenceOf(score: number | null): MatchConfidence {
  if (score === null) return 'high';
  return score >= MEDIUM_CONFIDENCE_MIN ? 'medium' : 'low';
}
