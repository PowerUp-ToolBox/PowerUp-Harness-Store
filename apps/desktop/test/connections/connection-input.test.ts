import { describe, expect, it } from 'vitest';
import {
  customConnectionId,
  isNameTaken,
  keyHintFor,
  parseApiKey,
  parseBaseUrl,
  parseConnectionName,
} from '../../src/shared/connection-input.js';

describe('parseApiKey', () => {
  it.each([
    ['sk-ant-abc', 'sk-ant-abc'],
    ['  sk-ant-abc\n', 'sk-ant-abc'],
    ['', undefined],
    ['   ', undefined],
    ['sk-ant abc', null],
    ['sk-ant-\nabc', null],
    ['sk-ant-\u0000abc', null],
  ])('%j → %j', (raw, expected) => {
    expect(parseApiKey(raw)).toBe(expected);
  });
});

describe('parseBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    [' https://example.com/v1/ ', 'https://example.com/v1'],
    ['https://example.com//', 'https://example.com'],
    ['', undefined],
    ['example.com/v1', null],
    ['ftp://example.com/v1', null],
    ['file:///etc/passwd', null],
    ['javascript:alert(1)', null],
  ])('%j → %j', (raw, expected) => {
    expect(parseBaseUrl(raw)).toBe(expected);
  });
});

describe('parseConnectionName', () => {
  it('trims, and allows 1 to 64 characters', () => {
    expect(parseConnectionName('  vLLM at work ')).toBe('vLLM at work');
    expect(parseConnectionName('  ')).toBeNull();
    expect(parseConnectionName('a'.repeat(64))).toBe('a'.repeat(64));
    expect(parseConnectionName('a'.repeat(65))).toBeNull();
    // Characters, not UTF-16 units: 64 emoji fit.
    expect(parseConnectionName('🦙'.repeat(64))).toBe('🦙'.repeat(64));
  });

  it('isNameTaken ignores letter case and surrounding spaces', () => {
    expect(isNameTaken('VLLM at Work', ['vllm at work'])).toBe(true);
    expect(isNameTaken(' home proxy ', ['Home proxy'])).toBe(true);
    expect(isNameTaken('home proxy 2', ['Home proxy'])).toBe(false);
  });
});

describe('customConnectionId', () => {
  it.each([
    ['vLLM at work', 'openai-compatible:vllm-at-work'],
    ['  --Home   Proxy!! ', 'openai-compatible:home-proxy'],
    ['公司的 vLLM', 'openai-compatible:vllm'],
    ['我的端点', 'openai-compatible:endpoint'],
    ['🦙', 'openai-compatible:endpoint'],
  ])('%j → %s', (name, id) => {
    expect(customConnectionId(name, new Set())).toBe(id);
  });

  it('appends -2, -3 … when the id is taken', () => {
    const taken = new Set(['openai-compatible:vllm', 'openai-compatible:vllm-2']);
    expect(customConnectionId('VLLM!', taken)).toBe('openai-compatible:vllm-3');
    expect(customConnectionId('其他', new Set(['openai-compatible:endpoint']))).toBe(
      'openai-compatible:endpoint-2',
    );
  });
});

describe('keyHintFor', () => {
  it('is the last 4 characters of a key of 12 or more, else nothing', () => {
    expect(keyHintFor('sk-ant-0123456789')).toBe('6789');
    expect(keyHintFor('abcdefghijkl')).toBe('ijkl');
    expect(keyHintFor('abcdefghijk')).toBe('');
    expect(keyHintFor('abcd')).toBe('');
  });
});
