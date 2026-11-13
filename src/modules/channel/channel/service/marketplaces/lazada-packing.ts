import { CARRIER_REQUIRED, MarketplaceError, type CarrierOption, type MarketplaceAdapter, type PackageItemsRef } from './common.ts';

export interface LazadaPackingDeps {
  download?: (url: string) => Promise<Uint8Array>;
}

type Row = Record<string, unknown>;
type LazadaCall = (path: string, params: Record<string, string>, method: 'GET' | 'POST' | 'FORM') => Promise<Row>;
type PackingMethods = Pick<MarketplaceAdapter, 'shipmentProviders' | 'packItems' | 'readyToShip' | 'repackPackage' | 'shippingDocuments'>;

// Giới hạn lô của ReadyToShip và PrintAWB.
const RTS_BATCH = 20;
const DOCUMENT_BATCH = 20;
const asRow = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(asRow) : [];
const str = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const unexpected = () => new MarketplaceError('rejected', 'unexpected_response', 'Phản hồi đóng gói của sàn không đầy đủ');

function resultData(body: Row) {
  const result = asRow(body.result);
  if (result.success !== true) {
    throw new MarketplaceError('rejected', str(result.error_code ?? result.errorCode) || 'unexpected_response', str(result.error_msg ?? result.errorMsg) || undefined);
  }
  return asRow(result.data);
}

function checkItems(items: Row[], key: string, requested: readonly string[]) {
  for (const item of items) {
    const code = str(item.item_err_code);
    if (code && code !== '0') throw new MarketplaceError('rejected', code, str(item.msg) || undefined);
  }
  const received = new Set(items.map((item) => str(item[key])));
  if (items.length !== requested.length || received.size !== requested.length ||
      items.some((item) => str(item.item_err_code) !== '0') || !requested.every((id) => received.has(id))) {
    throw unexpected();
  }
}

const packages = (codes: readonly string[]) => codes.map((package_id) => ({ package_id }));

export function lazadaPackingMethods(call: LazadaCall, deps: Required<LazadaPackingDeps>): PackingMethods {
  async function shipmentProviders(accessToken: string, ref: PackageItemsRef) {
    const data = resultData(await call('/order/shipment/providers/get', {
      access_token: accessToken,
      getShipmentProvidersReq: JSON.stringify({ orders: [{ order_id: ref.externalOrderId, order_item_ids: ref.externalLineIds }] }),
    }, 'GET'));
    if (data.shipping_allocate_type === 'TFS') return { platformChooses: true, items: [] };
    if (data.shipping_allocate_type !== 'NTFS') throw unexpected();

    const items: CarrierOption[] = rows(data.shipment_providers).map((provider) => {
      const code = str(provider.provider_code);
      const name = str(provider.name);
      if (!code || !name) throw unexpected();
      return { code, name, isDefault: [code, name].includes(str(data.platform_default)) };
    });
    return { platformChooses: false, items };
  }

  return {
    shipmentProviders,
    async packItems(accessToken, ref) {
      const providers = await shipmentProviders(accessToken, ref);
      const selected = providers.items.find((item) => item.code === ref.carrierCode);
      if (!providers.platformChooses && !selected) {
        throw new MarketplaceError('rejected', CARRIER_REQUIRED, 'Chọn nhà vận chuyển trong danh sách');
      }
      const data = resultData(await call('/order/fulfill/pack', {
        access_token: accessToken,
        packReq: JSON.stringify({
          pack_order_list: [{ order_id: ref.externalOrderId, order_item_list: ref.externalLineIds }],
          delivery_type: 'dropship',
          shipping_allocate_type: providers.platformChooses ? 'TFS' : 'NTFS',
          ...(selected && { shipment_provider_code: selected.code }),
        }),
      }, 'FORM'));
      const orders = rows(data.pack_order_list);
      const items = orders.flatMap((order) => rows(order.order_item_list));
      checkItems(items, 'order_item_id', ref.externalLineIds);
      const packageCode = str(items[0]?.package_id);
      if (orders.length !== 1 || str(orders[0]?.order_id) !== ref.externalOrderId ||
          !packageCode || items.some((item) => str(item.package_id) !== packageCode)) throw unexpected();
      return {
        packageCode,
        trackingCode: items.map((item) => str(item.tracking_number)).find(Boolean) ?? null,
        carrier: selected ? { code: selected.code, name: selected.name } : null,
      };
    },
    async readyToShip(accessToken, codes) {
      for (let offset = 0; offset < codes.length; offset += RTS_BATCH) {
        const batch = codes.slice(offset, offset + RTS_BATCH);
        const data = resultData(await call('/order/package/rts', {
          access_token: accessToken,
          readyToShipReq: JSON.stringify({ packages: packages(batch) }),
        }, 'POST'));
        checkItems(rows(data.packages), 'package_id', batch);
      }
    },
    async repackPackage(accessToken, code) {
      const data = resultData(await call('/order/package/repack', {
        access_token: accessToken,
        rePackReq: JSON.stringify({ packages: packages([code]) }),
      }, 'POST'));
      checkItems(rows(data.packages), 'package_id', [code]);
    },
    async shippingDocuments(accessToken, codes) {
      const files: Uint8Array[] = [];
      for (let offset = 0; offset < codes.length; offset += DOCUMENT_BATCH) {
        const data = resultData(await call('/order/package/document/get', {
          access_token: accessToken,
          getDocumentReq: JSON.stringify({ doc_type: 'PDF', packages: packages(codes.slice(offset, offset + DOCUMENT_BATCH)) }),
        }, 'GET'));
        if (typeof data.pdf_url !== 'string' || !data.pdf_url) {
          throw new MarketplaceError('unavailable', 'document_download_failed', 'Sàn trả tệp vận đơn hỏng, thử lại sau');
        }
        files.push(await deps.download(data.pdf_url));
      }
      return files;
    },
  };
}
