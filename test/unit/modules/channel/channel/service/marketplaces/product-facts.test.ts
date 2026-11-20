// Trường dùng chung của sản phẩm sàn khi ghép SKU (#497, Documents/21 §18.5): mô tả bỏ HTML, cân nặng gam, kích thước mm theo
// SKU, ảnh, ảnh bảng kích cỡ. Tên trường theo lần gọi thật 20/11/2026: TikTok Get Product 202309 (request_id
// 202611202334328A97039DD11D94143E7E: `brand.name`, `main_images[].urls`, `size_chart.image.urls`, `package_weight`,
// `package_dimensions` cấp sản phẩm); Lazada `/product/item/get` (request_id 2101248d17951887633343753: `attributes.description`,
// `attributes.brand`, `images[]`, `skus[].package_weight` kg, `package_length|width|height` cm, `attributes.size_chart`).
import { describe, expect, it } from 'vitest';
import { plainDescription, toGrams, toMillimeters } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { lazadaProductFacts } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { tiktokProductFacts } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';

describe('plainDescription', () => {
  it('bỏ thẻ, script, style; xuống dòng theo khối; giải mã thực thể; gộp khoảng trắng', () => {
    const html = '<p>Bình&nbsp;giữ  nhiệt</p><script>alert(1)</script><ul><li>500ml</li><li>Thép &amp; nhựa &#39;PP&#x27;</li></ul><style>p{}</style>';
    expect(plainDescription(html)).toBe("Bình giữ nhiệt\n500ml\nThép & nhựa 'PP'");
  });

  it('rỗng, không phải chuỗi, chỉ có thẻ: null; quá 5000 ký tự thì cắt', () => {
    expect(plainDescription('')).toBeNull();
    expect(plainDescription(undefined)).toBeNull();
    expect(plainDescription('<p> </p>')).toBeNull();
    expect(plainDescription(`<p>${'a'.repeat(6000)}</p>`)).toHaveLength(5000);
  });
});

describe('toGrams, toMillimeters', () => {
  it('đổi đơn vị, làm tròn, nhận chuỗi số', () => {
    expect(toGrams('0.45')).toBe(450);
    expect(toGrams(1, 'POUND')).toBe(454);
    expect(toMillimeters('25')).toBe(250);
    expect(toMillimeters(2, 'INCH')).toBe(51);
  });

  it('không phải số dương, đơn vị lạ: null', () => {
    expect(toGrams('0')).toBeNull();
    expect(toGrams('abc')).toBeNull();
    expect(toGrams(undefined)).toBeNull();
    expect(toMillimeters(-3)).toBeNull();
    expect(toMillimeters(3, 'FOOT')).toBeNull();
  });
});

describe('tiktokProductFacts', () => {
  it('thương hiệu, mô tả, ảnh chính, bảng kích cỡ; cân nặng, kích thước cấp sản phẩm áp cho mọi SKU', () => {
    const facts = tiktokProductFacts({
      brand: { id: '1', name: 'Lock&Lock' },
      description: '<p>Bình giữ nhiệt</p>',
      main_images: [{ uri: 'a', urls: ['https://p16.tiktok/a.jpg', 'https://p16.tiktok/a2.jpg'] }, { uri: 'b', urls: [] }],
      size_chart: { image: { uri: 's', urls: ['https://p16.tiktok/s.jpg'] } },
      package_weight: { value: '0.5', unit: 'KILOGRAM' },
      package_dimensions: { length: '20', width: '8', height: '8', unit: 'CENTIMETER' },
      skus: [{ id: '17001' }, { id: '17002' }],
    });
    expect(facts).toEqual({
      brand: 'Lock&Lock',
      description: 'Bình giữ nhiệt',
      imageUrls: ['https://p16.tiktok/a.jpg'],
      sizeChartUrl: 'https://p16.tiktok/s.jpg',
      skus: [
        { externalSkuId: '17001', weightG: 500, lengthMm: 200, widthMm: 80, heightMm: 80 },
        { externalSkuId: '17002', weightG: 500, lengthMm: 200, widthMm: 80, heightMm: 80 },
      ],
    });
  });

  it('thiếu mọi trường: rỗng, không ném', () => {
    expect(tiktokProductFacts(undefined)).toEqual({ brand: null, description: null, imageUrls: [], sizeChartUrl: null, skus: [] });
  });
});

describe('lazadaProductFacts', () => {
  it('ảnh http, bảng kích cỡ là link, cân nặng, kích thước theo từng SKU', () => {
    const facts = lazadaProductFacts(
      ['https://vn-live.slatic.net/a.jpg', '', 'ftp://x/b.jpg'],
      { brand: 'No Brand', description: '<p>Áo thun</p>', size_chart: 'https://vn-live.slatic.net/s.jpg' },
      [
        { SkuId: 9001, package_weight: '0.2', package_length: '30', package_width: '20', package_height: '2' },
        { SkuId: '9002', package_weight: '', package_length: '30' },
        { package_weight: '1' },
      ],
    );
    expect(facts).toEqual({
      brand: 'No Brand',
      description: 'Áo thun',
      imageUrls: ['https://vn-live.slatic.net/a.jpg'],
      sizeChartUrl: 'https://vn-live.slatic.net/s.jpg',
      skus: [
        { externalSkuId: '9001', weightG: 200, lengthMm: 300, widthMm: 200, heightMm: 20 },
        { externalSkuId: '9002', weightG: null, lengthMm: 300, widthMm: null, heightMm: null },
      ],
    });
  });

  it('bảng kích cỡ không phải link (chữ tự nhập): null', () => {
    expect(lazadaProductFacts(undefined, { size_chart: 'S M L' }, undefined).sizeChartUrl).toBeNull();
  });
});
