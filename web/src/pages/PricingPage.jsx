import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';

const fallbackPlans = [
  { id: 'free', name: '免费版', price: 0, unit: '永久免费', description: '建立求职画像并开始管理进度', features: ['基础岗位搜索与收藏', '完整岗位匹配解释', '求职进度管理', '2 个备考方向', '每日 5 次答题'], availableForCheckout: false },
  { id: 'pro', name: '专业版', price: 39, unit: '/月', description: '适合希望系统提升求职效率的用户', features: ['全部备考方向', '岗位库薪酬样本洞察', '更高每日练习配额'], availableForCheckout: true, availabilityLabel: '支付渠道接入后开放' },
  { id: 'coach', name: '求职加速版', price: 129, unit: '/月', description: '高强度冲刺服务预览', features: ['包含专业版全部权益', '更高练习配额', '真人辅导服务筹备中（暂不可购买）'], availableForCheckout: false, availabilityLabel: '真人服务筹备中' },
];

function featureLabel(feature) {
  return typeof feature === 'string' ? feature : feature?.label || '';
}

export function PricingPage() {
  const online = useOnline();
  const [searchParams] = useSearchParams();
  const [plans, setPlans] = useState(fallbackPlans);
  const [entitlements, setEntitlements] = useState(null);
  const [paymentConfigured, setPaymentConfigured] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([api.billing.plans(controller.signal), api.billing.entitlements(controller.signal)]).then(([planResult, entitlementResult]) => {
      if (planResult.status === 'fulfilled') {
        const items = listPayload(planResult.value, 'plans').items;
        if (items.length) setPlans(items);
        setPaymentConfigured(Boolean(planResult.value?.paymentConfigured));
      }
      if (entitlementResult.status === 'fulfilled') {
        setEntitlements(entitlementResult.value);
        setPaymentConfigured(current => current || Boolean(entitlementResult.value?.paymentConfigured));
      }
    });
    return () => controller.abort();
  }, []);

  const accountReady = Boolean(entitlements?.plan || entitlements?.planId);
  const currentPlan = entitlements?.planId || entitlements?.plan?.id || entitlements?.plan || '';
  const checkout = async planId => {
    if (planId === currentPlan || planId === 'free') return;
    setLoadingPlan(planId); setError('');
    try {
      const data = await api.billing.checkout(planId);
      const target = data?.checkout?.url || data?.checkoutUrl || data?.url;
      if (target) window.location.assign(target);
      else setError('支付页面暂时不可用，请稍后重试');
    } catch (requestError) { setError(requestError.message); } finally { setLoadingPlan(''); }
  };

  return (
    <div className="page pricing-page">
      <header className="pricing-header"><Link className="back-link" to="/profile"><Icon name="arrowLeft" size={18} />返回我的</Link><h1>选择适合你的求职节奏</h1><p>免费开始；¥39 / ¥129 为内测拟定月价，正式售价与购买状态以开放时的账户页面为准。</p></header>
      {searchParams.get('success') === '1' && <div className="form-success pricing-message"><Icon name="checkCircle" size={19} />已返回套餐页，请以“当前套餐”标识为最终结果。</div>}
      {searchParams.get('cancelled') === '1' && <div className="inline-notice">已返回套餐页；是否产生扣款请以支付渠道记录和“当前套餐”标识为准。</div>}
      {error && <div className="form-error pricing-message" role="alert">{error}</div>}
      <section className="plan-grid">
        {plans.map((plan, index) => {
          const id = plan.id || plan.code;
          const rawFeatures = Array.isArray(plan.features) ? plan.features : fallbackPlans[index]?.features || [];
          const features = rawFeatures.filter(feature => id === 'free' || !featureLabel(feature).includes('完整岗位匹配解释'));
          if (id === 'free' && !features.some(feature => featureLabel(feature).includes('完整岗位匹配解释'))) features.splice(1, 0, '完整岗位匹配解释');
          const majorLimit = Number(plan.entitlements?.['profile.majors']);
          if (Number.isFinite(majorLimit) && majorLimit >= 0 && !features.some(feature => featureLabel(feature) === `最多保存 ${majorLimit} 个专业方向`)) {
            features.push(`最多保存 ${majorLimit} 个专业方向`);
          }
          const active = id === currentPlan;
          const price = plan.price?.amount ?? plan.price ?? 0;
          const canCheckout = Boolean(plan.availableForCheckout) && paymentConfigured && accountReady;
          const buttonLabel = active
            ? '当前套餐'
            : id === 'free' ? '免费使用'
              : !plan.availableForCheckout ? (plan.availabilityLabel || '敬请期待')
                : !paymentConfigured ? '支付待接入'
                  : !accountReady ? '正在核对账户…'
                  : `升级${plan.name}`;
          return <article className={`plan-column${id === 'pro' ? ' featured' : ''}`} key={id}>
            <header><h2>{plan.name}</h2><p>{plan.description}</p><div className="plan-price"><strong>{price ? `${plan.price?.currencySymbol || '¥'}${price}` : '免费'}</strong><span>{plan.unit || (price ? '/月' : '永久免费')}</span></div>{price ? <small className="plan-price-note">内测拟定价格</small> : null}</header>
            <ul>{features.map(feature => <li key={featureLabel(feature)}><Icon name="check" size={15} />{featureLabel(feature)}</li>)}</ul>
            <button className={`button full ${id === 'free' ? 'secondary' : 'primary'}`} type="button" disabled={active || loadingPlan === id || !online || !canCheckout} onClick={() => checkout(id)}>{loadingPlan === id ? '正在前往支付…' : buttonLabel}</button>
          </article>;
        })}
      </section>
      <section className="pricing-foot"><Icon name="lock" size={18} /><p>{paymentConfigured ? '支付由服务器端创建结账会话；前端不会保存银行卡信息。套餐、价格和可用权益以结账页为准。' : '支付渠道尚未接入；当前仅展示内测拟定套餐与价格，不会发起扣款。'}</p></section>
    </div>
  );
}
