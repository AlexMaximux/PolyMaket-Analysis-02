import { describe, it, expect, vi } from 'vitest';
import { checkLocalRequest } from '../src/lib/requestGuard';

describe('checkLocalRequest', () => {
  it('allows same-origin writes from localhost and 127.0.0.1 on any port', () => {
    expect(checkLocalRequest('POST', 'localhost:8000', 'http://localhost:8000')).toBeNull();
    expect(checkLocalRequest('DELETE', '127.0.0.1:3001', 'http://127.0.0.1:3001')).toBeNull();
  });
  it('allows writes without an Origin header (curl, server-to-server)', () => {
    expect(checkLocalRequest('POST', '127.0.0.1:8000', null)).toBeNull();
  });
  it('allows cross-origin reads', () => {
    expect(checkLocalRequest('GET', 'localhost:8000', 'https://evil.example')).toBeNull();
  });
  it('blocks cross-origin writes', () => {
    expect(checkLocalRequest('POST', 'localhost:8000', 'https://evil.example')).not.toBeNull();
    expect(checkLocalRequest('POST', 'localhost:8000', 'http://localhost:9999')).not.toBeNull();
  });
  it('blocks Origin: null (sandboxed iframe, file://)', () => {
    expect(checkLocalRequest('POST', 'localhost:8000', 'null')).not.toBeNull();
  });
  it('blocks foreign Host headers (DNS rebinding, LAN access) for every method', () => {
    expect(checkLocalRequest('GET', 'evil.example:8000', null)).not.toBeNull();
    expect(checkLocalRequest('GET', '192.168.1.141:8000', null)).not.toBeNull();
    expect(checkLocalRequest('GET', null, null)).not.toBeNull();
  });
  it('accepts IPv6 loopback', () => {
    expect(checkLocalRequest('POST', '[::1]:8000', 'http://[::1]:8000')).toBeNull();
  });
  it('allows remote hosts when ALLOW_REMOTE_ACCESS is set', () => {
    process.env.ALLOW_REMOTE_ACCESS = 'true';
    expect(checkLocalRequest('GET', '13.41.194.69', null)).toBeNull();
    expect(checkLocalRequest('POST', '13.41.194.69', 'http://13.41.194.69')).toBeNull();
    delete process.env.ALLOW_REMOTE_ACCESS;
  });
  it('allows specific hosts in ALLOWED_HOSTS', () => {
    process.env.ALLOWED_HOSTS = 'my-domain.com,13.41.194.69';
    expect(checkLocalRequest('GET', '13.41.194.69', null)).toBeNull();
    expect(checkLocalRequest('GET', 'other.com', null)).not.toBeNull();
    delete process.env.ALLOWED_HOSTS;
  });
  it('does not implicitly allow remote hosts in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try { expect(checkLocalRequest('POST', 'untrusted.example', null)).not.toBeNull(); }
    finally { vi.unstubAllEnvs(); }
  });

});
