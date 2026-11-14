import { describe, expect, it } from 'vitest';
import { PURPOSE_RULES, rejectUpload, storageKeyOf } from '#src/modules/core/files/domain/upload-rules.ts';

const MB = 1024 * 1024;

describe('rejectUpload: kiểu và cỡ theo mục đích (Documents/21 §5.3, §14.3)', () => {
  it.each(['image/jpeg', 'image/png'])('ảnh sản phẩm nhận %s', (type) => {
    expect(rejectUpload('product_image', type, 1024)).toBeNull();
  });

  it('ảnh sản phẩm không nhận WebP (sàn chỉ nhận JPG, PNG)', () => {
    expect(rejectUpload('product_image', 'image/webp', 1024)).toBe('file_type_not_allowed');
  });

  it('đính kèm vẫn nhận WebP', () => {
    expect(rejectUpload('attachment', 'image/webp', 1024)).toBeNull();
  });

  it('ảnh sản phẩm không nhận PDF', () => {
    expect(rejectUpload('product_image', 'application/pdf', 1024)).toBe('file_type_not_allowed');
  });

  it('đính kèm nhận PDF', () => {
    expect(rejectUpload('attachment', 'application/pdf', 1024)).toBeNull();
  });

  it.each(['video/mp4', 'image/gif', 'image/svg+xml', 'text/html'])('không nhận %s (MVP không nhận video)', (type) => {
    expect(rejectUpload('attachment', type, 1024)).toBe('file_type_not_allowed');
  });

  it('so kiểu không phân biệt hoa thường', () => {
    expect(rejectUpload('product_image', 'IMAGE/PNG', 1024)).toBeNull();
  });

  it('ảnh sản phẩm đúng 1 MB thì nhận, hơn 1 byte thì từ chối', () => {
    expect(rejectUpload('product_image', 'image/png', MB)).toBeNull();
    expect(rejectUpload('product_image', 'image/png', MB + 1)).toBe('file_too_large');
  });

  it('đính kèm tối đa 10 MB', () => {
    expect(rejectUpload('attachment', 'application/pdf', 10 * MB)).toBeNull();
    expect(rejectUpload('attachment', 'application/pdf', 10 * MB + 1)).toBe('file_too_large');
  });

  it('kiểm kiểu trước cỡ', () => {
    expect(rejectUpload('product_image', 'video/mp4', 100 * MB)).toBe('file_type_not_allowed');
  });

  it('ảnh sản phẩm vào bucket công khai, đính kèm vào bucket riêng', () => {
    expect(PURPOSE_RULES.product_image.visibility).toBe('public');
    expect(PURPOSE_RULES.attachment.visibility).toBe('private');
  });
});

describe('storageKeyOf', () => {
  const id = '6f1c2a4e-0d6b-4c1e-9a55-2b7d1f3e8c90';

  it('ghép tiền tố môi trường, id tệp và đuôi theo kiểu', () => {
    expect(storageKeyOf('staging', id, 'image/jpeg')).toBe(`staging/${id}.jpg`);
    expect(storageKeyOf('dev', id, 'application/pdf')).toBe(`dev/${id}.pdf`);
  });

  it('kiểu chưa có đuôi là lỗi lập trình', () => {
    expect(() => storageKeyOf('dev', id, 'video/mp4')).toThrow();
  });
});
