// 该脚本在文档创建前注入，只记录凭据是否存在，绝不复制 URL fragment 中的实际值。
// English: This script is injected before the document is created and only records whether the credentials
// exist and never copies the actual values in the URL fragment.
export const browserSessionProbeSource = `(() => {
  const values = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const safeBlockedTarget = (value) => {
    const raw = String(value ?? '');
    if (['inline', 'eval', 'wasm-eval', 'trusted-types-sink', 'trusted-types-policy'].includes(raw)) {
      return raw;
    }
    try {
      const parsed = new URL(raw, location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
      return parsed.protocol || '未知协议';
    } catch {
      return '无法解析的目标';
    }
  };
  const cspViolations = [];
  const probe = {
    hasLaunchCode: values.has('rgsLaunchCode'),
    hasOperatorId: values.has('rgsOperatorId'),
    hasSessionId: values.has('rgsSessionId'),
  };
  Object.defineProperty(probe, 'cspViolations', {
    enumerable: true,
    get: () => cspViolations.slice(),
  });
  Object.defineProperty(globalThis, '__localSessionProbe', {
    configurable: false,
    writable: false,
    value: probe,
  });
  globalThis.addEventListener('securitypolicyviolation', (event) => {
    if (cspViolations.length >= 16) return;
    cspViolations.push({
      effectiveDirective: String(event.effectiveDirective ?? ''),
      violatedDirective: String(event.violatedDirective ?? ''),
      disposition: String(event.disposition ?? ''),
      blockedTarget: safeBlockedTarget(event.blockedURI),
    });
  }, true);
  try {
    sessionStorage.setItem('__slots_probe__', 'ok');
    probe.storageWritable = sessionStorage.getItem('__slots_probe__') === 'ok';
    sessionStorage.removeItem('__slots_probe__');
  } catch {
    probe.storageWritable = false;
  }
})();`;
