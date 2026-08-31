import { Icon } from './Icon';

export function LoadingState({ rows = 4, compact = false, label = '正在加载' }) {
  return (
    <div className={`loading-state${compact ? ' compact' : ''}`} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-block skeleton-logo" />
          <span className="skeleton-lines"><i /><i /></span>
          <span className="skeleton-block skeleton-short" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message = '内容加载失败', onRetry }) {
  return (
    <div className="status-state" role="alert">
      <span className="status-icon error"><Icon name="refresh" /></span>
      <h2>暂时没有加载成功</h2>
      <p>{message}</p>
      {onRetry && <button className="button secondary" type="button" onClick={onRetry}><Icon name="refresh" size={17} />重新加载</button>}
    </div>
  );
}

export function EmptyState({ title, description, action, icon = 'search' }) {
  return (
    <div className="status-state">
      <span className="status-icon"><Icon name={icon} /></span>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function InlineNotice({ type = 'info', children }) {
  return <div className={`inline-notice ${type}`}>{children}</div>;
}
