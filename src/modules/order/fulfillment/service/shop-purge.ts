// Phần của fulfillment khi xoá gian hàng đã ngắt (#398): channel gọi trong giao dịch xoá, `withCompany` của nó.
import { deletePackages, deleteParcelsOfReturns, lockPackagesOfOrders } from '../repository/shop-purge.ts';
import { requestAllocation } from './allocation.ts';
import { stockPort } from './stock-port.ts';

/** Đơn và yêu cầu trả của một gian hàng (sales tra bằng `shopOrderRefs`). */
export interface ShopOrderRefs {
  orderIds: string[];
  returnRequestIds: string[];
}

export interface OrderPackagesPurge {
  packageIds: string[];
  parcelIds: string[];
  packages: number;
  packageLines: number;
  returnParcels: number;
}

/**
 * Xoá kiện của các đơn và kiện trả lạc gắn yêu cầu trả của gian hàng. Kiện còn giữ hàng thì nhả trước qua cổng tồn
 * (`release`: giảm Đang giữ, không đổi tồn thực, không ghi thẻ kho), xong xếp một lượt phân hàng cho SKU vừa nhả. Phải
 * chạy **trước** `purgeShopOrders` của sales trong **cùng** giao dịch: trigger kiểm bằng của dòng kiện hoãn tới commit
 * và chỉ bỏ qua khi dòng đơn đã mất.
 */
export async function purgeOrderPackages(refs: ShopOrderRefs): Promise<OrderPackagesPurge> {
  const locked = await lockPackagesOfOrders(refs.orderIds);
  const released = new Set<string>();
  for (const pkg of locked) {
    if (!pkg.held.length) continue;
    await stockPort().release(pkg.id, pkg.held);
    for (const l of pkg.held) released.add(l.variantId);
  }
  const packageIds = locked.map((p) => p.id);
  const counts = await deletePackages(packageIds);
  const parcelIds = await deleteParcelsOfReturns(refs.returnRequestIds);
  await requestAllocation([...released]);
  return { packageIds, parcelIds, ...counts, returnParcels: parcelIds.length };
}
