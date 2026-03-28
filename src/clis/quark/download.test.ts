import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildQuarkClientDownloadRawActLink,
  buildQuarkClientSelectDirectoryAppleScript,
  expandHomeDirectory,
  getQuarkClientBundleIdForPort,
  isQuarkWebDownloadSizeLimited,
  resolveQuarkOutputDirectory,
  normalizeQuarkClientActLinkForPort,
  trimQuarkClientDownloadList,
} from './download.js';

describe('quark download client handoff helpers', () => {
  it('detects when Quark web downloads exceed the 50 MB browser limit', () => {
    expect(isQuarkWebDownloadSizeLimited(50 * 1024 * 1024)).toBe(false);
    expect(isQuarkWebDownloadSizeLimited(50 * 1024 * 1024 + 1)).toBe(true);
  });

  it('normalizes and caps the client handoff file list', () => {
    const input = [' a ', '', 'b', '   ', ...Array.from({ length: 60 }, (_, index) => `id-${index}`)];
    const result = trimQuarkClientDownloadList(input);

    expect(result[0]).toBe('a');
    expect(result[1]).toBe('b');
    expect(result).toHaveLength(50);
  });

  it('builds Quark client raw deeplinks for download ids', () => {
    expect(buildQuarkClientDownloadRawActLink('download-id')).toBe('qkclouddrive://download?id=download-id');
    expect(buildQuarkClientDownloadRawActLink('download-id', {
      scheme: 'browser',
      from: 'share',
      shareDn: 'pan.quark.cn',
    })).toBe('qklink://download?id=download-id&from=share&share_dn=pan.quark.cn');
  });

  it('switches raw deeplink schemes for browser-side desktop ports', () => {
    const raw = 'qkclouddrive://download?id=download-id';

    expect(normalizeQuarkClientActLinkForPort(raw, 9127)).toBe(raw);
    expect(normalizeQuarkClientActLinkForPort(raw, 9128)).toBe('qklink://download?id=download-id');
  });

  it('maps desktop ports to the matching Quark bundle id', () => {
    expect(getQuarkClientBundleIdForPort(9127)).toBe('com.alibaba.quark.clouddrive');
    expect(getQuarkClientBundleIdForPort(9128)).toBe('com.quark.desktop');
  });

  it('expands home-relative output directories before resolving them', () => {
    expect(expandHomeDirectory('~/Downloads')).toBe(path.join(os.homedir(), 'Downloads'));
    expect(resolveQuarkOutputDirectory('~/Downloads')).toBe(path.resolve(os.homedir(), 'Downloads'));
  });

  it('builds the AppleScript used to select the requested client download directory', () => {
    const script = buildQuarkClientSelectDirectoryAppleScript('com.quark.desktop').join('\n');

    expect(script).toContain('tell application id "com.quark.desktop" to activate');
    expect(script).toContain('set targetPath to POSIX path of (POSIX file targetPath)');
    expect(script).toContain('set targetProcess to my waitForTargetProcess()');
    expect(script).toContain('set downloadDialog to my waitForDownloadDialog(targetProcess)');
    expect(script).toContain('keystroke "g" using {command down, shift down}');
    expect(script).toContain('set goToFolderSheet to my waitForNestedSheet(downloadDialog)');
    expect(script).toContain('my setFirstTextFieldValue(goToFolderSheet, targetPath)');
    expect(script).toContain('my clickFirstButton(goToFolderSheet, {"前往", "Go"})');
    expect(script).toContain('my clickFirstButton(downloadDialog, {"选取", "Choose", "打开", "Open", "保存", "Save"})');
    expect(script).toContain('on waitForDownloadDialog(targetProcess)');
    expect(script).toContain('on clickFirstButton(container, buttonNames)');
  });
});
