function normalizePath(value, fallback, name) {
  let result = String(value || fallback).trim();
  if (!result.startsWith('/')) result = `/${result}`;
  result = result.replace(/\/{2,}/g, '/');
  if (result.length > 1) result = result.replace(/\/+$/, '');
  if (!result || /[?#\\]/.test(result) || result.split('/').includes('..')) {
    throw new Error(`${name} 必须是站点内的绝对路径`);
  }
  return result;
}

export function buildSettings(env = process.env) {
  const productPublicBase = normalizePath(env.PRODUCT_PUBLIC_BASE, '/app', 'PRODUCT_PUBLIC_BASE');
  const opsPublicBase = normalizePath(env.OPS_PUBLIC_BASE, '/ops', 'OPS_PUBLIC_BASE');
  if (productPublicBase === '/' || opsPublicBase === '/') throw new Error('产品端与运营端必须使用非根路径');
  if (productPublicBase === opsPublicBase) throw new Error('PRODUCT_PUBLIC_BASE 与 OPS_PUBLIC_BASE 不能相同');

  const productApiBase = productPublicBase === '/app' ? '/api/v1' : `${productPublicBase}/api/v1`;
  const opsApiBase = opsPublicBase === '/ops' ? '/api' : `${opsPublicBase}/api`;

  return {
    productPublicBase,
    productPublicBaseWithSlash: productPublicBase === '/' ? '/' : `${productPublicBase}/`,
    productApiBase,
    opsPublicBase,
    opsApiBase,
  };
}
