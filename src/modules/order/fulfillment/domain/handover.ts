// Luật thuần của bàn giao trừ tồn (spec 199a §5.2).

/** Ai đưa kiện vào nhóm rời kho; cùng giá trị enum `order.handover_source`. */
export type HandoverSource = 'scan' | 'marketplace' | 'forced' | 'before_cutoff';
