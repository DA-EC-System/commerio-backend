import { describe, expect, it } from 'vitest';
import {
  renderApprovedMail,
  renderRejectedMail,
  renderSubmittedMail,
} from '#src/modules/core/staff/service/decision-mail.ts';

// Thư báo người duyệt và thư báo kết quả của lời mời (Documents/21 mục 3.1).
const evil = '<img src=x onerror=alert(1)>';

describe('renderSubmittedMail', () => {
  const input = {
    companyName: 'Công ty Hoa Sen',
    fullName: 'Trần Thị Mai',
    email: 'mai@vi.du',
    roleNames: ['Sale', 'Nhân viên kho'],
    queueLink: 'https://commerio.test/admin/staff?tab=pending',
  };

  it('có người nộp, email, vai trò, link tab Chờ duyệt ở cả hai bản', () => {
    const { subject, text, html } = renderSubmittedMail(input);
    expect(subject).toBe('Có yêu cầu tham gia Công ty Hoa Sen chờ duyệt');
    for (const part of ['Trần Thị Mai', 'mai@vi.du', 'Sale, Nhân viên kho', input.queueLink]) expect(text).toContain(part);
    expect(html).toContain(`href="${input.queueLink}"`);
  });

  it('escape họ tên, tên công ty, vai trò trong HTML; gộp xuống dòng ở tiêu đề', () => {
    const { subject, html } = renderSubmittedMail({ ...input, fullName: evil, companyName: 'X\nY', roleNames: [evil] });
    expect(subject).toBe('Có yêu cầu tham gia X Y chờ duyệt');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('renderApprovedMail', () => {
  const input = {
    companyName: 'Công ty Hoa Sen',
    fullName: 'Trần Thị Mai',
    email: 'mai@vi.du',
    existingAccount: false,
    loginLink: 'https://commerio.test/login',
  };

  it('email mới: dùng mật khẩu đã đặt; có link đăng nhập', () => {
    const { subject, text, html } = renderApprovedMail(input);
    expect(subject).toContain('được duyệt');
    expect(text).toContain('mai@vi.du');
    expect(text).toContain('mật khẩu bạn đã đặt');
    expect(text).toContain(input.loginLink);
    expect(html).toContain(`href="${input.loginLink}"`);
  });

  it('tài khoản đã có: dùng mật khẩu hiện có', () => {
    expect(renderApprovedMail({ ...input, existingAccount: true }).text).toContain('mật khẩu hiện có');
  });

  it('escape họ tên trong HTML', () => {
    expect(renderApprovedMail({ ...input, fullName: evil }).html).not.toContain('<img');
  });
});

describe('renderRejectedMail', () => {
  it('báo không được duyệt, không có link, escape họ tên', () => {
    const { subject, text, html } = renderRejectedMail({ companyName: 'Công ty Hoa Sen', fullName: evil });
    expect(subject).toBe('Yêu cầu tham gia Công ty Hoa Sen không được duyệt');
    expect(text).not.toMatch(/https?:/);
    expect(html).not.toContain('<img');
  });
});
