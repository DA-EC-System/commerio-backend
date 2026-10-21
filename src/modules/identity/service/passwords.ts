// Băm mật khẩu đã chuyển sang shared/crypto (#7) để staff dùng chung; giữ đường dẫn cũ cho identity.
export { hashPassword, verifyPassword } from '../../../shared/crypto/password.ts';
