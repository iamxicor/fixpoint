import { describe, expect, it } from 'vitest';
import { parseTargetId, pickTarget, sourceMapUrlForBundle } from './metro.js';
import type { InspectorTarget } from './types.js';

const target = (id: string, deviceName: string): InspectorTarget => ({
  id,
  title: `com.example.app (${deviceName})`,
  description: 'React Native Bridgeless [C++ connection]',
  appId: 'com.example.app',
  type: 'node',
  webSocketDebuggerUrl: `ws://localhost:8081/inspector/debug?device=${id.split('-')[0]}&page=${id.split('-')[1]}`,
  deviceName,
  reactNative: { logicalDeviceId: id.split('-')[0]!, capabilities: { supportsMultipleDebuggers: true } },
});

describe('pickTarget', () => {
  it('ignores a physical device attached to the same Metro', () => {
    const sim = target('aaaa-1', 'iPhone 17');
    const phone = target('bbbb-1', 'iPhone');
    expect(pickTarget([phone, sim], { deviceName: 'iPhone 17' })?.id).toBe('aaaa-1');
    expect(pickTarget([phone], { deviceName: 'iPhone 17' })).toBeUndefined();
  });

  it('prefers the highest page for a device (new RN instance after reload or dev-client switch)', () => {
    const old = target('aaaa-1', 'iPhone 17');
    const fresh = target('aaaa-2', 'iPhone 17');
    expect(pickTarget([old, fresh], { deviceName: 'iPhone 17' })?.id).toBe('aaaa-2');
    expect(pickTarget([fresh, old], { deviceName: 'iPhone 17' })?.id).toBe('aaaa-2');
  });

  it('parses target ids', () => {
    expect(parseTargetId('2610c661bf1bc785358b7d25898d16f209bc4889-12')).toEqual({ device: '2610c661bf1bc785358b7d25898d16f209bc4889', page: 12 });
  });
});

describe('sourceMapUrlForBundle', () => {
  it('maps the Metro bundle URL to the map URL with the same query', () => {
    const bundle =
      'http://localhost:8081/node_modules/expo-router/entry.bundle?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes';
    expect(sourceMapUrlForBundle(bundle)).toBe(
      'http://localhost:8081/node_modules/expo-router/entry.map?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes',
    );
  });

  it('handles the `//&` artefact Hermes puts in frame URLs', () => {
    const bundle = 'http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true';
    expect(sourceMapUrlForBundle(bundle)).toBe('http://127.0.0.1:8081/node_modules/expo-router/entry.map?platform=ios&dev=true');
  });

  it('returns null for non-bundle URLs', () => {
    expect(sourceMapUrlForBundle('NativeRequest.__native_constructor__')).toBeNull();
  });
});
