import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';

export function SalaryPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    api.salary.insights(controller.signal).then(setData).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [reloadKey]);

  if (loading) return <div className="page"><LoadingState rows={5} /></div>;
  if (error?.details?.code === 'ENTITLEMENT_LIMIT' && !data) return <div className="page salary-page"><div className="locked-content salary-locked"><span><Icon name="lock" size={28} /></span><h1>专业版薪酬洞察</h1><p>升级后可基于当前岗位库中的公开薪资样本，对比目标岗位、城市与期望区间。</p><Link className="button primary" to="/pricing">查看套餐权益</Link></div></div>;
  if (error && !data) return <div className="page"><ErrorState message={error.message} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  const target = data?.target || data?.salaryTarget || {};
  const market = data?.market || {};
  const percentileValue = data?.percentile ?? market.percentile;
  const percentile = percentileValue === null || percentileValue === undefined ? null : Number(percentileValue);
  const hasPercentile = Number.isFinite(percentile);
  const targetMin = target.min === null || target.min === undefined ? null : Number(target.min);
  const targetMax = target.max === null || target.max === undefined ? null : Number(target.max);
  const hasTarget = Number.isFinite(targetMin) && Number.isFinite(targetMax) && (targetMin > 0 || targetMax > 0);
  const formatAmount = value => value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);
  const targetDisplay = target.display || (hasTarget ? `${formatAmount(targetMin)}–${formatAmount(targetMax)}` : '待补充');
  const comparisons = listPayload(data?.comparisons || data?.roles || [], 'comparisons').items;
  const sampleSize = data?.sampleSize ?? market.sampleSize;
  const recommendations = data?.recommendations || [
    '比较年包时把固定薪资、奖金、补贴和股权拆开计算。',
    '进入面试后再结合职责范围与职级确认薪资区间。',
    '准备两套期望：理想目标与可接受底线，避免临场失去判断。',
  ];

  return (
    <div className="page salary-page">
      <header className="page-header"><div><h1>薪酬洞察</h1><p>把薪资、奖金、股权和城市成本放在一起，判断机会是否值得。</p></div><Link className="button secondary" to="/profile"><Icon name="edit" size={17} />编辑薪酬目标</Link></header>
      <section className="salary-overview">
        <div className="salary-target-block"><span>你的期望薪资</span><strong>{targetDisplay}</strong><p>{hasTarget ? `${target.currency || 'CNY'} · ${target.period === 'year' ? '税前年薪' : target.period === 'hour' ? '税前时薪' : '税前月薪'}${target.months ? ` · ${target.months} 薪` : ''}` : '在个人画像中设置币种、周期与区间'}</p></div>
        <div className="market-position">
          <header><span>{market.scope || '相关岗位'}样本位置</span><strong>{hasPercentile ? `处于第 ${percentile} 百分位` : '样本不足'}</strong></header>
          <div className={`distribution${hasPercentile ? '' : ' insufficient'}`}>{hasPercentile && <i style={{ left: `${Math.min(95, Math.max(5, percentile))}%` }}><b /></i>}</div>
          <footer><span>入门</span><span>市场中位</span><span>高竞争力</span></footer>
        </div>
        <div className="salary-confidence"><Icon name="target" size={31} /><p><strong>{data?.summaryTitle || (sampleSize ? '薪酬样本已更新' : '公开薪资样本不足')}</strong><span>{data?.summary || (sampleSize ? `当前分析使用 ${sampleSize} 条可解析岗位薪资。` : '当前岗位库没有足够的同类公开薪资，暂不推断市场位置。')}</span></p></div>
      </section>

      <div className="salary-content-grid">
        <section className="salary-comparison">
          <div className="section-title-row"><div><h2>相关岗位薪酬参考</h2><p>基于当前岗位库与用户画像整理</p></div></div>
          {comparisons.length ? <div className="salary-table">
            <div className="salary-table-head"><span>岗位方向</span><span>城市</span><span>常见区间</span><span>年包构成</span></div>
            {comparisons.map((item, index) => <article key={item.id || item.role || index}><div><strong>{item.role || item.title || '岗位未命名'}</strong><span>{item.level || item.experience || '经验未注明'}</span></div><span>{item.location || item.city || '地点未注明'}</span><strong>{item.range || item.salary || '薪资未公开'}</strong><span>{item.package || item.composition || '构成未公开'}</span></article>)}
          </div> : <EmptyState title="完善岗位方向后查看薪酬参考" description="至少填写一个目标岗位与意向城市，才能得到有意义的比较。" icon="coin" action={<Link className="button primary" to="/profile">完善画像</Link>} />}
        </section>
        <aside className="salary-advice">
          <h2>谈薪准备</h2>
          <ol>{recommendations.map((item, index) => <li key={item}><i>{index + 1}</i><p>{typeof item === 'string' ? item : item.text}</p></li>)}</ol>
          <Link to="/prep">练习薪资沟通题 <Icon name="chevronRight" size={16} /></Link>
        </aside>
      </div>
      <footer className="salary-source-note"><span>样本数：{sampleSize ?? '待补充'}</span><span>来源：{data?.source || '当前岗位库公开薪资'}</span>{data?.updatedAt && <span>更新：{new Date(data.updatedAt).toLocaleDateString('zh-CN')}</span>}<p>{data?.disclaimer || '薪酬信息仅供求职决策参考，实际待遇以招聘方与正式 Offer 为准。'}</p></footer>
    </div>
  );
}
