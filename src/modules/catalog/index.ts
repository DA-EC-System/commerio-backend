// API công khai của module `catalog`: danh mục, thuộc tính, sản phẩm, biến thể, quy tắc SKU.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../shared/module.ts';

export const catalogModule: ModuleDefinition = { name: 'catalog' };
